using System.Text.Json;

namespace Toolize.Core;

/// <summary>A place a key could live. Real drives at runtime; temp folders in tests.</summary>
public sealed record DriveOption(string Root, string Label, long Bytes, bool HasKey)
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

        foreach (var (root, file) in ReadCandidates())
        {
            var key = enrolled.FirstOrDefault(k => k.Id == file.Id);
            if (key is null) continue;

            // Counter first. A copy taken before the last rotation carries both a stale
            // counter AND a stale secret, so checking the secret first would report it as
            // merely "invalid" and lose the one thing Tier A can actually prove.
            if (file.Counter < key.Counter)
                return new UnlockCheck(UnlockStatus.Clone, key,
                    $"the key on {root} is a copy taken earlier (counter {file.Counter}, expected {key.Counter})");

            var hash = Secrets.Hash(file.Secret);
            if (hash != key.SecretHash && hash != key.PendingHash)
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
            VolumeSerial = $"{drive.Label}|{drive.Bytes}",
        };
        Write(drive.Root, new KeyFile { Id = key.Id, Secret = secret, Counter = key.Counter });
        return key;
    }

    public EnrolledKey Rotate(EnrolledKey key)
    {
        var found = ReadCandidates().FirstOrDefault(c => c.File.Id == key.Id);
        if (found.Root is null) return key; // drive went away mid-check; try again next time

        var secret = Secrets.NewSecret();
        var next = key with { PendingHash = Secrets.Hash(secret), Counter = key.Counter + 1 };
        // Write the drive first. Crash before it and the old secret still verifies; crash
        // after and the pending hash does. Either way the key keeps working — a rotation
        // that bricked the only key would be far worse than a missed rotation.
        Write(found.Root, new KeyFile { Id = key.Id, Secret = secret, Counter = next.Counter });
        return next with { SecretHash = next.PendingHash!, PendingHash = null, LastSeen = DateTimeOffset.UtcNow };
    }

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
            .Select(d => new DriveOption(
                d.RootDirectory.FullName,
                string.IsNullOrWhiteSpace(d.VolumeLabel) ? "USB drive" : d.VolumeLabel,
                SizeOf(d),
                File.Exists(KeyPath(d.RootDirectory.FullName)))),
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

    private IEnumerable<(string Root, KeyFile File)> ReadCandidates()
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
            if (file is not null) yield return (drive.Root, file);
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
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal); // hidden files can't be overwritten
        File.WriteAllText(path, JsonSerializer.Serialize(file, new JsonSerializerOptions(Protocol.Json) { WriteIndented = true }));
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
