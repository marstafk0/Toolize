using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// Notices a browser running without the extension reporting in, and reacts.
///
/// Two cases it catches: the extension disabled or removed in a browser we manage, and a
/// browser we cannot manage at all (Firefox and friends can't run the extension, so they
/// are an unfiltered window onto everything).
///
/// Closing someone's browser is rude and destructive, so it is deliberately the last
/// step: a grace period first, a visible warning during it, and never a hard kill while
/// a graceful close will do. Watchdog.Warn stops after the warning, and that is the
/// default — the user opts in to having windows closed.
/// </summary>
public sealed class WatchdogService(
    StateStore store,
    ExtensionTracker extension,
    ILogger<WatchdogService> log)
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(10);
    /// <summary>How long a managed browser may run unprotected before we act.</summary>
    private static readonly TimeSpan Grace = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Browsers that can run the extension, by process name, with the name the extension
    /// reports itself under. Each is expected to check in on its own.
    /// </summary>
    public static readonly (string Process, string Browser, string Display)[] Managed =
    [
        ("chrome", "chrome", "Chrome"),
        ("msedge", "edge", "Edge"),
        ("brave", "brave", "Brave"),
    ];

    /// <summary>Browsers that cannot run it at all, so their mere presence is a hole.</summary>
    public static readonly string[] Unmanaged =
        ["firefox", "opera", "opera_gx", "vivaldi", "librewolf", "waterfox", "palemoon", "tor"];

    private DateTimeOffset? _unprotectedSince;
    public string Status { get; private set; } = "idle";

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Check();
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "watchdog pass failed");
            }
            try
            {
                await Task.Delay(Tick, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private void Check()
    {
        var settings = store.Settings;
        if (!settings.Enforce || settings.Watchdog == Watchdog.Off)
        {
            _unprotectedSince = null;
            Status = "off";
            return;
        }

        // Judge each managed browser on its own: the extension checking in from Chrome
        // says nothing about Edge, where it may be disabled.
        var anyManaged = false;
        var silent = new List<(string Display, List<Process> Processes)>();
        foreach (var (process, browser, display) in Managed)
        {
            var running = Running([process]);
            if (running.Count == 0) continue;
            anyManaged = true;
            // The watchdog only runs under enforcement, where the store copy is the one
            // pinned in place; a dev copy checking in doesn't count.
            if (!extension.IsConnected(browser, AppInfo.StoreExtensionId)) silent.Add((display, running));
        }
        var unmanagedRunning = Running(Unmanaged);

        if (silent.Count == 0 && unmanagedRunning.Count == 0)
        {
            if (_unprotectedSince is not null) store.Note("browser protection restored");
            _unprotectedSince = null;
            Status = anyManaged ? "browser protected" : "no browser running";
            return;
        }

        _unprotectedSince ??= DateTimeOffset.UtcNow;
        var elapsed = DateTimeOffset.UtcNow - _unprotectedSince.Value;
        var reasons = new List<string>();
        if (unmanagedRunning.Count > 0)
            reasons.Add($"{string.Join(", ", unmanagedRunning.Select(p => p.ProcessName).Distinct())} can't run Toolize");
        if (silent.Count > 0)
            reasons.Add($"the Web Store extension isn't running in {string.Join(", ", silent.Select(s => s.Display))}");
        var reason = string.Join("; ", reasons);
        Status = $"unprotected for {elapsed.TotalSeconds:F0}s — {reason}";

        if (elapsed < Grace) return;

        // Only the browsers that are actually unprotected; a protected one stays open.
        var targets = unmanagedRunning.Concat(silent.SelectMany(s => s.Processes)).ToList();
        if (settings.Watchdog == Watchdog.Warn)
        {
            Warn(reason, close: false);
            _unprotectedSince = DateTimeOffset.UtcNow; // don't nag continuously
            return;
        }

        Warn(reason, close: true);
        store.Note($"closing browsers: {reason}");
        foreach (var process in targets) CloseGracefully(process);
        _unprotectedSince = null;
    }

    private static List<Process> Running(string[] names) =>
    [
        .. names.SelectMany(n =>
        {
            try
            {
                return Process.GetProcessesByName(n);
            }
            catch
            {
                return [];
            }
        }),
    ];

    /// <summary>
    /// Ask first, then insist. A graceful close lets the browser save its session, so
    /// reopening it doesn't cost the user their tabs.
    /// </summary>
    private void CloseGracefully(Process process)
    {
        try
        {
            if (process.HasExited) return;
            process.CloseMainWindow();
            if (process.WaitForExit(5000)) return;
            process.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "could not close {Process}", process.ProcessName);
        }
    }

    /// <summary>
    /// Tells the user what is happening, in the interactive session rather than a log
    /// nobody reads. The GUI shows this too, but a browser about to close deserves a
    /// message on screen.
    /// </summary>
    private void Warn(string reason, bool close)
    {
        var text = close
            ? $"Toolize is closing your browser: {reason}."
            : $"Toolize can't see its protection running: {reason}.";
        log.LogWarning("{Text}", text);
        try
        {
            SessionNotifier.Show("Toolize", text);
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "could not show the warning");
        }
    }
}
