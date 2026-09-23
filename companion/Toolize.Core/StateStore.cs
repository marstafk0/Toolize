using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Toolize.Core;

/// <summary>
/// Everything the service must remember, on disk under %ProgramData%\Toolize.
///
/// Encrypted with machine-scope DPAPI and written to a directory standard users can't
/// modify, so a user-context process can neither read nor rewrite the lock state. That
/// only matters once the account model is in place (the user must not be an admin);
/// until then it's defence in depth, not a guarantee.
///
/// Reads never throw: a corrupt or tampered file falls back to defaults, which are the
/// *protective* values. Fail safe, never fail open.
/// </summary>
public sealed class StateStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Toolize.state.v1");
    private readonly string _path;
    private readonly object _gate = new();
    private State _state;

    public StateStore(string? directory = null)
    {
        Directory = directory ?? DefaultDirectory();
        System.IO.Directory.CreateDirectory(Directory);
        HardenDirectory(Directory);
        _path = Path.Combine(Directory, "state.dat");
        _state = Load();
    }

    public string Directory { get; }

    /// <summary>
    /// Production state lives in %ProgramData% where the service (SYSTEM) owns it. Dev
    /// state lives in %LOCALAPPDATA% so a dev instance needs no elevation at all.
    /// </summary>
    public static string DefaultDirectory(bool dev = false) => dev
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Toolize", "dev-state")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Toolize");

    public Settings Settings
    {
        get { lock (_gate) return _state.Settings; }
    }

    public string? Channel
    {
        get { lock (_gate) return _state.Channel; }
    }

    public Settings UpdateSettings(Settings settings)
    {
        lock (_gate)
        {
            _state = _state with { Settings = settings };
            Save();
            return settings;
        }
    }

    public void SetChannel(string channel)
    {
        lock (_gate)
        {
            _state = _state with { Channel = channel };
            Save();
        }
    }

    /// <summary>Append-only tamper/audit note. Records that something happened, never what was viewed.</summary>
    public void Note(string message)
    {
        lock (_gate)
        {
            var notes = _state.Notes.TakeLast(199).Append($"{DateTimeOffset.UtcNow:O} {message}").ToList();
            _state = _state with { Notes = notes };
            Save();
        }
    }

    public IReadOnlyList<string> Notes
    {
        get { lock (_gate) return _state.Notes; }
    }

    private State Load()
    {
        try
        {
            if (!File.Exists(_path)) return new State();
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), Entropy, DataProtectionScope.LocalMachine);
            return JsonSerializer.Deserialize<State>(plain, Protocol.Json) ?? new State();
        }
        catch
        {
            // Unreadable or tampered with: start from protective defaults and say so.
            var fresh = new State { Notes = [$"{DateTimeOffset.UtcNow:O} state unreadable, reset to defaults"] };
            return fresh;
        }
    }

    private void Save()
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(_state, Protocol.Json);
        var cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, cipher);
        File.Move(tmp, _path, overwrite: true); // atomic-ish: never leave a half-written state
    }

    /// <summary>
    /// Administrators and SYSTEM may write; everyone else may only read.
    ///
    /// Only applied when we're actually elevated: the installed service runs as SYSTEM,
    /// but a dev instance runs as you, and handing itself a read-only directory would
    /// lock it out of its own state.
    /// </summary>
    private static void HardenDirectory(string dir)
    {
        if (!OperatingSystem.IsWindows() || !IsElevated()) return;
        try
        {
            var info = new DirectoryInfo(dir);
            var acl = info.GetAccessControl();
            acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var (sid, rights) in new (WellKnownSidType, FileSystemRights)[]
                     {
                         (WellKnownSidType.LocalSystemSid, FileSystemRights.FullControl),
                         (WellKnownSidType.BuiltinAdministratorsSid, FileSystemRights.FullControl),
                         (WellKnownSidType.BuiltinUsersSid, FileSystemRights.ReadAndExecute),
                     })
            {
                acl.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(sid, null), rights,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
            }
            info.SetAccessControl(acl);
        }
        catch
        {
            // Best effort: losing the ACL costs defence in depth, not correctness.
        }
    }

    private static bool IsElevated()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private sealed record State
    {
        public Settings Settings { get; init; } = Settings.Default;
        public string Channel { get; init; } = "stable";
        public IReadOnlyList<string> Notes { get; init; } = [];
    }
}
