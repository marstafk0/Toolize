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

/// <summary>Tracks the browser extension's heartbeat and pushes settings revisions to watchers.</summary>
public sealed class ExtensionTracker
{
    public const int MaxWatchers = 16;
    private static readonly TimeSpan Stale = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan DefaultHold = TimeSpan.FromSeconds(25);

    private sealed record Entry(string? Version, int Blocked, int Checked, DateTimeOffset LastSeen);

    private readonly object _gate = new();
    /// <summary>
    /// Last check-in per (browser, extension id). Browser "" is an extension too old to
    /// say which; id "" means the native host couldn't tell.
    /// </summary>
    private readonly Dictionary<(string Browser, string Id), Entry> _seen = new();
    private TaskCompletionSource<int> _changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _revision = 1;
    private int _watchers;
    private DateTimeOffset _settingsChangedAt = DateTimeOffset.UtcNow;

    public int Revision
    {
        get { lock (_gate) return _revision; }
    }

    public DateTimeOffset SettingsChangedAt
    {
        get { lock (_gate) return _settingsChangedAt; }
    }

    public int ActiveWatchers
    {
        get { lock (_gate) return _watchers; }
    }

    public ExtensionState State
    {
        get
        {
            lock (_gate)
            {
                var fresh = _seen.Where(p => Fresh(p.Value.LastSeen)).ToList();
                var latest = _seen.Values.OrderByDescending(e => e.LastSeen).FirstOrDefault();
                var freshLatest = fresh.Select(p => p.Value).OrderByDescending(e => e.LastSeen).FirstOrDefault();
                var connectedBrowsers = fresh
                    .Where(p => p.Key.Browser != "")
                    .Select(p => new BrowserStatus(
                        FormatBrowser(p.Key.Browser, p.Key.Id),
                        p.Value.Version ?? "",
                        p.Value.LastSeen))
                    .OrderBy(b => b.Name, StringComparer.Ordinal)
                    .ToList();
                var browsers = connectedBrowsers.Select(b => b.Name).Distinct().Order().ToList();
                return new ExtensionState
                {
                    Connected = fresh.Count > 0,
                    Version = (freshLatest ?? latest)?.Version,
                    LastSeen = latest?.LastSeen,
                    Blocked = fresh.Sum(p => p.Value.Blocked),
                    Checked = fresh.Sum(p => p.Value.Checked),
                    Browsers = browsers,
                    ConnectedBrowsers = connectedBrowsers,
                };
            }
        }
    }

    private static string FormatBrowser(string browser, string id) =>
        id == AppInfo.StoreExtensionId ? browser : $"{browser} (dev build)";

    /// <summary>
    /// Whether the extension in this particular browser is reporting in. One browser
    /// checking in says nothing about another: Chrome being protected must not cover
    /// for Edge with the extension disabled.
    ///
    /// With <paramref name="extensionId"/>, only that build counts. Under enforcement that
    /// is the store copy: an unpacked dev copy reports in just the same, but nothing stops
    /// anyone removing it, so it must not count as protection.
    /// </summary>
    public bool IsConnected(string browser, string? extensionId = null)
    {
        var norm = Normalize(browser);
        lock (_gate)
        {
            return _seen.Any(p => p.Key.Browser == norm
                                  && (extensionId is null || p.Key.Id == extensionId)
                                  && Fresh(p.Value.LastSeen));
        }
    }

    private static bool Fresh(DateTimeOffset seen) => DateTimeOffset.UtcNow - seen < Stale;

    public void Hello(string? version, string? browser, string? extensionId)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var key = (Normalize(browser), extensionId ?? "");
            var prev = _seen.GetValueOrDefault(key);
            _seen[key] = new Entry(version ?? prev?.Version, prev?.Blocked ?? 0, prev?.Checked ?? 0, now);
        }
    }

    public void Heartbeat(ExtensionHeartbeatArgs args)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var key = (Normalize(args.Browser), args.ExtensionId ?? "");
            _seen[key] = new Entry(args.Version, args.Blocked, args.Checked, now);
        }
    }

    private static string Normalize(string? browser) => browser?.Trim().ToLowerInvariant() ?? "";

    /// <summary>Bumps the settings revision and wakes any held `watch-settings` callers.</summary>
    public int SettingsChanged()
    {
        TaskCompletionSource<int> old;
        int rev;
        lock (_gate)
        {
            rev = ++_revision;
            _settingsChangedAt = DateTimeOffset.UtcNow;
            old = _changed;
            _changed = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        old.TrySetResult(rev);
        return rev;
    }

    /// <summary>
    /// Returns immediately if <paramref name="callerRevision"/> is behind <see cref="Revision"/>;
    /// otherwise holds until the revision advances or <paramref name="hold"/> elapses.
    /// </summary>
    public async Task<(bool Accepted, int Revision)> WatchAsync(int? callerRevision, CancellationToken ct, TimeSpan? hold = null)
    {
        Task<int> waitTask;
        lock (_gate)
        {
            if (callerRevision is null || callerRevision.Value < _revision)
                return (true, _revision);
            if (_watchers >= MaxWatchers)
                return (false, _revision);
            _watchers++;
            waitTask = _changed.Task;
        }

        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(hold ?? DefaultHold);
            try
            {
                var nextRev = await waitTask.WaitAsync(timeoutCts.Token);
                return (true, nextRev);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // Hold timer elapsed cleanly; answer with the current revision.
                return (true, Revision);
            }
        }
        finally
        {
            lock (_gate) _watchers--;
        }
    }
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
        try
        {
            File.Copy(installer, Path.Combine(store.Directory, "previous-installer.exe"), overwrite: true);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "could not save previous-installer.exe for rollback");
        }
        store.Note($"installing update {AppInfo.Version} -> {_manifest.Version}");

        // Close our own GUI and CLI first. They hold the files being replaced, and the
        // installer cannot close them itself: it runs in session 0, while they are in
        // the user's session. Leaving them open used to abort the update silently.
        CloseOurClients();

        var logPath = Path.Combine(Path.GetTempPath(), $"Toolize-install-{_manifest.Version}.log");
        // The installer stops the service, swaps the files and starts it again, so this
        // process is replaced mid-flight — hence no wait, and no work after this point.
        Process.Start(new ProcessStartInfo(installer)
        {
            Arguments = $"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=\"{logPath}\"",
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
public sealed class DoctorService(
    StateStore store,
    ExtensionTracker extension,
    LockService locks,
    EnforcementService enforcement,
    bool dev = false,
    Func<bool>? devPipeExists = null)
{
    private readonly Func<bool> _devPipeExists = devPipeExists ?? (() =>
        OperatingSystem.IsWindows() && File.Exists($@"\\.\pipe\{Protocol.PipeName(dev: true)}"));

    public Task<IReadOnlyList<Check>> RunAsync(CancellationToken ct)
    {
        var extState = extension.State;
        var checks = new List<Check>
        {
            new("Service", true, $"running, version {AppInfo.Version}"),
            new("State directory", Directory.Exists(store.Directory), store.Directory),
            new("Extension", extState.Connected,
                extState.Connected
                    ? $"connected, version {extState.Version}"
                    : "not connected — install it from the browser, or check the native messaging host",
                Fix: "Open the browser and confirm Toolize is enabled"),
        };

        if (extState.ConnectedBrowsers.Count > 0)
        {
            var changedAt = extension.SettingsChangedAt;
            var rev = extension.Revision;
            var stale = extState.ConnectedBrowsers.Where(b => b.LastSeen < changedAt).Select(b => b.Name).ToList();
            var synced = stale.Count == 0;
            checks.Add(new Check("Settings sync", synced,
                synced
                    ? $"all connected browsers ({string.Join(", ", extState.ConnectedBrowsers.Select(b => b.Name))}) on revision {rev}"
                    : $"waiting for {string.Join(", ", stale)} to pick up revision {rev}",
                Fix: synced ? null : "Wait a few seconds for the next heartbeat or reload the extension"));
        }

        if (!dev && _devPipeExists())
        {
            checks.Add(new Check("Dev instance", true,
                $"warning: a dev instance is also running on \\\\.\\pipe\\{Protocol.PipeName(dev: true)} alongside the installed service",
                Fix: "Stop the dev service (`--console` / `--dev`) if you aren't actively testing"));
        }

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
