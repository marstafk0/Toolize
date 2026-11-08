using System.Management;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Toolize.Core;

/// <summary>A place a key could live. Real drives at runtime; temp folders in tests.</summary>
public sealed record DriveOption(
    string Root,
    string Label,
    long Bytes,
    bool HasKey,
    string? VolumeSerial = null,
    string? HardwareSerial = null)
{
    /// <summary>How the drive is named to the user and on the command line ("D:").</summary>
    public string Letter => Root.TrimEnd(Path.DirectorySeparatorChar);
}

/// <summary>
/// Tier A: a dedicated USB flash drive holding a keyfile.
///
/// Be honest about what this is. The file can be copied and the drive's serial can be
/// spoofed by someone determined, so this is friction, not proof of possession. What it
/// does give you is *evidence*: the secret rotates on every check, so if a copy and the
/// original are both ever used, one of them presents a stale counter and Toolize records
/// a clone. A copy used while the original never is stays undetected until the original
/// comes back — say that in the UI, don't imply more.
///
/// Tier B (FIDO2/YubiKey) is the answer when that isn't good enough.
/// </summary>
public sealed class FlashDriveProvider(Func<IReadOnlyList<DriveOption>>? drives = null) : IUnlockProvider
{
    public const string KeyDirectory = ".toolize";
    public const string KeyFileName = "key.json";

    /// <summary>
    /// Where to look for keys. Defaults to the machine's removable drives; tests point it
    /// at temporary folders so the rotation and clone rules can be exercised for real.
    /// </summary>
    private readonly Func<IReadOnlyList<DriveOption>> _drives = drives ?? Removable;

    public string Tier => "flash";

    public IReadOnlyList<DriveOption> Available() => SafeDrives();

    public UnlockCheck Check(IReadOnlyList<EnrolledKey> enrolled)
    {
        if (enrolled.Count == 0) return new UnlockCheck(UnlockStatus.Absent);

        foreach (var (drive, file) in ReadCandidates())
        {
            var root = drive.Root;
            var key = enrolled.FirstOrDefault(k => k.Id == file.Id);
            if (key is null) continue;

            // Keys enrolled before serial binding stored "{Label}|{Bytes}" in VolumeSerial.
            // Accept those as-is and upgrade them on the next rotation so existing users
            // aren't locked out; for real serials, a mismatch means the keyfile was copied
            // onto another stick.
            if (!IsLegacyVolumeSerial(key.VolumeSerial))
            {
                var actualVolume = drive.VolumeSerial ?? ReadVolumeSerial(root);
                if (actualVolume is null || !string.Equals(actualVolume, key.VolumeSerial, StringComparison.OrdinalIgnoreCase))
                    return new UnlockCheck(UnlockStatus.Clone, key,
                        $"the key on {drive.Letter} is on a different drive than the one enrolled");
            }

            // The hardware serial comes from WMI, which can fail transiently; an unreadable
            // serial is no evidence of anything, so only a different one counts.
            if (!string.IsNullOrEmpty(key.HardwareSerial))
            {
                var actualHardware = drive.HardwareSerial ?? ReadHardwareSerial(root);
                if (actualHardware is not null && !string.Equals(actualHardware, key.HardwareSerial, StringComparison.OrdinalIgnoreCase))
                    return new UnlockCheck(UnlockStatus.Clone, key,
                        $"the key on {drive.Letter} is on a different drive than the one enrolled");
            }

            // Counter first. A copy taken before the last rotation carries both a stale
            // counter AND a stale secret, so checking the secret first would report it as
            // merely "invalid" and lose the one thing Tier A can actually prove.
            if (file.Counter < key.Counter)
                return new UnlockCheck(UnlockStatus.Clone, key,
                    $"the key on {root} is a copy taken earlier (counter {file.Counter}, expected {key.Counter})");

            var hash = Secrets.Hash(file.Secret);
            var matchesCurrent = hash == key.SecretHash && file.Counter == key.Counter;
            var matchesPending = key.PendingHash is not null && hash == key.PendingHash && file.Counter == key.Counter + 1;
            if (!matchesCurrent && !matchesPending)
                return new UnlockCheck(UnlockStatus.Invalid, key, $"the key on {root} doesn't match the enrolled one");

            return new UnlockCheck(UnlockStatus.Verified, key, root);
        }
        return new UnlockCheck(UnlockStatus.Absent);
    }

    public EnrolledKey Enroll(string target, string name)
    {
        var drive = Find(target)
                    ?? throw new InvalidOperationException($"{target} isn't a removable drive that's ready — pick a USB stick");

        var secret = Secrets.NewSecret();
        var key = new EnrolledKey
        {
            Id = Guid.NewGuid().ToString("n")[..12],
            Name = name,
            Tier = Tier,
            SecretHash = Secrets.Hash(secret),
            Counter = 1,
            VolumeSerial = drive.VolumeSerial ?? ReadVolumeSerial(drive.Root),
            HardwareSerial = drive.HardwareSerial ?? ReadHardwareSerial(drive.Root),
        };
        Write(drive.Root, new KeyFile { Id = key.Id, Secret = secret, Counter = key.Counter });
        return key;
    }

    public EnrolledKey Rotate(EnrolledKey key, Action<EnrolledKey>? persist = null)
    {
        var found = ReadCandidates().FirstOrDefault(c => c.File.Id == key.Id);
        if (found.Drive is null) return key; // drive went away mid-check; try again next time

        var root = found.Drive.Root;
        var upgradedVolume = IsLegacyVolumeSerial(key.VolumeSerial)
            ? (found.Drive.VolumeSerial ?? ReadVolumeSerial(root) ?? key.VolumeSerial)
            : key.VolumeSerial;
        var upgradedHardware = string.IsNullOrEmpty(key.HardwareSerial)
            ? (found.Drive.HardwareSerial ?? ReadHardwareSerial(root))
            : key.HardwareSerial;

        var secret = Secrets.NewSecret();
        var nextHash = Secrets.Hash(secret);
        var pending = key with
        {
            PendingHash = nextHash,
            VolumeSerial = upgradedVolume,
            HardwareSerial = upgradedHardware,
        };
        // Two-phase rotation: (a) record PendingHash (counter unchanged) before touching
        // the stick; (b) write the stick atomically with Counter + 1; (c) commit
        // SecretHash = PendingHash, PendingHash = null, Counter + 1. Crash before (b) and
        // the old secret still verifies; crash after (b) and PendingHash with Counter + 1
        // verifies. Either way the key is never bricked.
        persist?.Invoke(pending);
        Write(root, new KeyFile { Id = key.Id, Secret = secret, Counter = key.Counter + 1 });
        var committed = pending with
        {
            SecretHash = nextHash,
            PendingHash = null,
            Counter = key.Counter + 1,
            LastSeen = DateTimeOffset.UtcNow,
        };
        persist?.Invoke(committed);
        return committed;
    }

    public static bool IsLegacyVolumeSerial(string? serial) =>
        string.IsNullOrEmpty(serial) || serial.Contains('|');

    /// <summary>Reads the filesystem volume serial number (hex) via GetVolumeInformationW.</summary>
    public static string? ReadVolumeSerial(string root)
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            var rootPath = Path.GetPathRoot(root);
            if (string.IsNullOrEmpty(rootPath)) rootPath = root;
            if (!rootPath.EndsWith(Path.DirectorySeparatorChar))
                rootPath += Path.DirectorySeparatorChar;
            return GetVolumeInformationW(rootPath, null, 0, out var serial, out _, out _, null, 0) && serial != 0
                ? serial.ToString("X8")
                : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Hardware serials by (drive letter, volume serial). WMI takes tens to hundreds of
    /// milliseconds per query and the key is polled every second; a stick's serial can't
    /// change while it stays plugged in, and a different stick in the same letter has a
    /// different volume serial, so the pair is a safe cache key.
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string?> HardwareSerials = new();

    /// <summary>
    /// Reads the physical USB disk's hardware serial via WMI (Win32_DiskDrive.SerialNumber
    /// joined through Win32_LogicalDiskToPartition), best effort, cached per plugged-in drive.
    /// </summary>
    public static string? ReadHardwareSerial(string root)
    {
        if (!OperatingSystem.IsWindows()) return null;
        var volume = ReadVolumeSerial(root);
        if (volume is null) return QueryHardwareSerial(root); // not a real volume: no caching
        var cacheKey = $"{Path.GetPathRoot(root)}|{volume}";
        if (HardwareSerials.TryGetValue(cacheKey, out var cached) && cached is not null) return cached;
        var serial = QueryHardwareSerial(root);
        if (serial is not null) HardwareSerials[cacheKey] = serial; // a failed read is retried next time
        return serial;
    }

    private static string? QueryHardwareSerial(string root)
    {
        try
        {
            var rootPath = Path.GetPathRoot(root) ?? root;
            var letter = rootPath.TrimEnd(Path.DirectorySeparatorChar);
            if (letter.Length != 2 || letter[1] != ':') return null;

            using var partitions = new ManagementObjectSearcher(
                $"ASSOCIATORS OF {{Win32_LogicalDisk.DeviceID='{letter}'}} WHERE AssocClass = Win32_LogicalDiskToPartition");
            foreach (var partition in partitions.Get().OfType<ManagementObject>())
            {
                using (partition)
                {
                    var partId = partition["DeviceID"]?.ToString();
                    if (string.IsNullOrWhiteSpace(partId)) continue;
                    using var drives = new ManagementObjectSearcher(
                        $"ASSOCIATORS OF {{Win32_DiskPartition.DeviceID='{partId}'}} WHERE AssocClass = Win32_DiskDriveToDiskPartition");
                    foreach (var disk in drives.Get().OfType<ManagementObject>())
                    {
                        using (disk)
                        {
                            var serial = disk["SerialNumber"]?.ToString()?.Trim();
                            if (!string.IsNullOrWhiteSpace(serial)) return serial;
                        }
                    }
                }
            }
        }
        catch
        {
            // WMI unavailable or virtual/temp folder: best effort only.
        }
        return null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeInformationW(
        string lpRootPathName,
        char[]? lpVolumeNameBuffer,
        int nVolumeNameSize,
        out uint lpVolumeSerialNumber,
        out uint lpMaximumComponentLength,
        out uint lpFileSystemFlags,
        char[]? lpFileSystemNameBuffer,
        int nFileSystemNameSize);

    private DriveOption? Find(string target)
    {
        var wanted = target.TrimEnd(Path.DirectorySeparatorChar, ':');
        return _drives().FirstOrDefault(d =>
            string.Equals(d.Root.TrimEnd(Path.DirectorySeparatorChar, ':'), wanted, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Removable drives that are ready, for the enrollment picker.</summary>
    public static IReadOnlyList<DriveOption> Removable() =>
    [
        .. DriveInfo.GetDrives()
            .Where(d => d is { DriveType: DriveType.Removable, IsReady: true })
            .Select(d =>
            {
                var root = d.RootDirectory.FullName;
                return new DriveOption(
                    root,
                    string.IsNullOrWhiteSpace(d.VolumeLabel) ? "USB drive" : d.VolumeLabel,
                    SizeOf(d),
                    File.Exists(KeyPath(root)),
                    ReadVolumeSerial(root),
                    ReadHardwareSerial(root));
            }),
    ];

    private static long SizeOf(DriveInfo d)
    {
        try
        {
            return d.TotalSize;
        }
        catch
        {
            return 0;
        }
    }

    public static string KeyPath(string root) => Path.Combine(root, KeyDirectory, KeyFileName);

    private IEnumerable<(DriveOption Drive, KeyFile File)> ReadCandidates()
    {
        foreach (var drive in SafeDrives())
        {
            KeyFile? file = null;
            try
            {
                var path = KeyPath(drive.Root);
                if (File.Exists(path)) file = JsonSerializer.Deserialize<KeyFile>(File.ReadAllText(path), Protocol.Json);
            }
            catch
            {
                // Unreadable drive or malformed file: treat as no key, never as a pass.
            }
            if (file is not null) yield return (drive, file);
        }
    }

    private IReadOnlyList<DriveOption> SafeDrives()
    {
        try
        {
            return _drives();
        }
        catch
        {
            return [];
        }
    }

    private static void Write(string root, KeyFile file)
    {
        var path = KeyPath(root);
        var tmp = path + ".tmp";
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(tmp)) File.SetAttributes(tmp, FileAttributes.Normal);
        File.WriteAllText(tmp, JsonSerializer.Serialize(file, new JsonSerializerOptions(Protocol.Json) { WriteIndented = true }));
        if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal); // hidden files can't be overwritten
        File.Move(tmp, path, overwrite: true);
        try
        {
            File.SetAttributes(path, FileAttributes.Hidden); // tidiness, not protection
        }
        catch
        {
            /* some filesystems don't support it */
        }
    }
}
