using System.Diagnostics;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using Toolize.Core;

namespace Toolize.Service;

public static class AppInfo
{
    public static string Version =>
        Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>Public half of the release signing key; the private half never leaves the dev machine.</summary>
    public const string ReleasePublicKey = ReleaseKey.PublicKeyBase64;
    public const string Repo = ReleaseKey.Repo;
    /// <summary>The Web Store id, which is what policy force-installs.</summary>
    public const string StoreExtensionId = ReleaseKey.StoreExtensionId;
}

/// <summary>
/// The current lock state, published by <see cref="UnlockService"/> as it polls. Read it
/// for display; for a decision, call UnlockService.Refresh() so the answer is current.
/// </summary>
public sealed class LockService
{
    public LockState State { get; private set; } = new() { Enrolled = false, KeyPresent = false };

    public void Update(LockState state) => State = state;
}

/// <summary>Tracks the browser extension's heartbeat so the GUI can show whether it's alive.</summary>
public sealed class ExtensionTracker
{
    private readonly object _gate = new();
    private ExtensionState _state = new();
    /// <summary>Last check-in per browser. Key "" is an extension too old to say which.</summary>
    private readonly Dictionary<string, DateTimeOffset> _seen = new();

    /// <summary>Extension counts as connected only if it checked in recently.</summary>
    private static readonly TimeSpan Stale = TimeSpan.FromSeconds(90);

    public ExtensionState State
    {
        get
        {
            lock (_gate)
            {
                var live = _state.LastSeen is { } seen && Fresh(seen);
                var browsers = _seen.Where(p => p.Key != "" && Fresh(p.Value)).Select(p => p.Key).Order().ToList();
                return _state with { Connected = live, Browsers = browsers };
            }
        }
    }

    /// <summary>
    /// Whether the extension in this particular browser is reporting in. One browser
    /// checking in says nothing about another: Chrome being protected must not cover
    /// for Edge with the extension disabled.
    /// </summary>
    public bool IsConnected(string browser)
    {
        lock (_gate)
        {
            if (_seen.TryGetValue(browser, out var seen) && Fresh(seen)) return true;
            // An extension from before per-browser reporting can't say where it runs.
            // Trust it for any browser until it updates, as the watchdog always did.
            return _seen.TryGetValue("", out var unknown) && Fresh(unknown);
        }
    }

    private static bool Fresh(DateTimeOffset seen) => DateTimeOffset.UtcNow - seen < Stale;

    public void Hello(string? version, string? browser)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            _state = _state with { Version = version, LastSeen = now };
            _seen[Normalize(browser)] = now;
        }
    }

    public void Heartbeat(ExtensionHeartbeatArgs args)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            _state = _state with
            {
                Version = args.Version,
                LastSeen = now,
                Blocked = args.Blocked,
                Checked = args.Checked,
            };
            _seen[Normalize(args.Browser)] = now;
        }
    }

    private static string Normalize(string? browser) => browser?.Trim().ToLowerInvariant() ?? "";

    /// <summary>Settings changed elsewhere; the extension picks them up on its next heartbeat.</summary>
    public void SettingsChanged() { }
}

public sealed record ApplyResult(bool Ok, string Message);

/// <summary>Checks for, downloads and applies updates. See <see cref="Updater"/> for the trust model.</summary>
public sealed class UpdateService(StateStore store, ILogger<UpdateService> log)
{
    private readonly Updater _updater = new(AppInfo.Repo, AppInfo.ReleasePublicKey);

    public UpdateInfo? Last { get; private set; }
    private UpdateManifest? _manifest;

    public async Task<UpdateInfo> CheckAsync(CancellationToken ct)
    {
        var channel = store.Channel ?? "stable";
        try
        {
            _manifest = await _updater.FetchManifestAsync(channel, ct);
            if (_manifest is null)
            {
                return Last = new UpdateInfo { Version = AppInfo.Version, Available = false, Notes = "no release published yet" };
            }
            var available = Updater.IsNewer(_manifest.Version, AppInfo.Version);
            log.LogInformation("update check: {Current} -> {Latest} on {Channel} ({Available})",
                AppInfo.Version, _manifest.Version, channel, available ? "update available" : "up to date");
            return Last = new UpdateInfo
            {
                Version = _manifest.Version,
                Available = available,
                Notes = _manifest.Notes,
                InstallerUrl = _manifest.InstallerUrl,
                Sha256 = _manifest.InstallerSha256,
            };
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "update check failed");
            store.Note($"update check failed: {ex.Message}");
            return Last = new UpdateInfo { Version = AppInfo.Version, Available = false, Notes = ex.Message };
        }
    }

    public async Task<ApplyResult> ApplyAsync(CancellationToken ct)
    {
        if (_manifest is null) await CheckAsync(ct);
        if (_manifest is null) return new ApplyResult(false, "no release to install");
        if (!Updater.IsNewer(_manifest.Version, AppInfo.Version)) return new ApplyResult(false, "already up to date");

        var installer = await _updater.DownloadInstallerAsync(_manifest, ct);
        store.Note($"installing update {AppInfo.Version} -> {_manifest.Version}");

        // Close our own GUI and CLI first. They hold the files being replaced, and the
        // installer cannot close them itself: it runs in session 0, while they are in
        // the user's session. Leaving them open used to abort the update silently.
        CloseOurClients();

        var log = Path.Combine(Path.GetTempPath(), $"Toolize-install-{_manifest.Version}.log");
        // The installer stops the service, swaps the files and starts it again, so this
        // process is replaced mid-flight — hence no wait, and no work after this point.
        Process.Start(new ProcessStartInfo(installer)
        {
            Arguments = $"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=\"{log}\"",
            UseShellExecute = true,
        });
        return new ApplyResult(true, $"installing {_manifest.Version}");
    }

    private void CloseOurClients()
    {
        foreach (var name in new[] { "Toolize.Gui", "Toolize.Cli" })
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                try
                {
                    process.Kill();
                    process.WaitForExit(3000);
                }
                catch (Exception ex)
                {
                    log.LogDebug(ex, "could not close {Name}", name);
                }
            }
        }
    }
}

/// <summary>
/// Reports what is and isn't in place. In phase 3 this is mostly informational; from
/// phase 5 it becomes the checklist that says whether protection is actually enforced.
/// </summary>
public sealed class DoctorService(StateStore store, ExtensionTracker extension, LockService locks, EnforcementService enforcement)
{
    public Task<IReadOnlyList<Check>> RunAsync(CancellationToken ct)
    {
        var checks = new List<Check>
        {
            new("Service", true, $"running, version {AppInfo.Version}"),
            new("State directory", Directory.Exists(store.Directory), store.Directory),
            new("Extension", extension.State.Connected,
                extension.State.Connected
                    ? $"connected, version {extension.State.Version}"
                    : "not connected — install it from the browser, or check the native messaging host",
                Fix: "Open the browser and confirm Toolize is enabled"),
        };

        foreach (var (name, key) in new[]
                 {
                     ("Chrome", @"SOFTWARE\Google\Chrome\NativeMessagingHosts\com.toolize.host"),
                     ("Edge", @"SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.toolize.host"),
                     ("Brave", @"SOFTWARE\BraveSoftware\Brave\NativeMessagingHosts\com.toolize.host"),
                 })
        {
            var registered = OperatingSystem.IsWindows() && Registry.LocalMachine.OpenSubKey(key) is not null;
            checks.Add(new Check($"{name} messaging host", registered,
                registered ? "registered" : "not registered (that browser simply won't talk to the app)"));
        }

        var lockState = locks.State;
        checks.Add(new Check("Unlock key", lockState.Enrolled,
            lockState.Enrolled
                ? lockState.KeyPresent ? $"{lockState.KeyName} is plugged in — changes allowed" : "locked: no key present"
                : "no key enrolled, so nothing is gated",
            Fix: lockState.Enrolled ? null : "Set up a USB key in the Toolize app"));
        if (lockState.Enrolled && !store.HasRecoveryCode)
            checks.Add(new Check("Recovery code", false, "no unused recovery code — losing every key would mean reinstalling"));
        checks.Add(new Check("Enforcement", enforcement.Applied,
            enforcement.Applied ? enforcement.Summary : "off — the extension can still be removed in the browser",
            Fix: enforcement.Applied ? null : "Turn on enforcement in the Toolize app"));
        checks.AddRange(enforcement.Inspect());
        return Task.FromResult<IReadOnlyList<Check>>(checks);
    }
}
