using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// Writes (and removes) the browser policy that makes the extension stick.
///
/// Reconciled on a timer rather than only on change: a policy someone edited by hand is
/// put back within seconds, and the service restarting is enough to repair the machine.
/// It only ever touches the handful of values listed in <see cref="PolicyPlan"/> — any
/// other policy on the machine, ours or not, is left exactly as it was.
///
/// This needs admin rights, which the service has as SYSTEM. Unelevated (a dev run) it
/// reports what it would do and changes nothing.
/// </summary>
public sealed class EnforcementService(StateStore store, ILogger<EnforcementService> log)
{
    private static readonly TimeSpan Reconcile = TimeSpan.FromSeconds(30);
    private readonly string _extensionId = AppInfo.StoreExtensionId;
    private string _lastSummary = "";

    /// <summary>What the last pass actually did, for status and doctor.</summary>
    public string Summary { get; private set; } = "not applied yet";
    public bool Applied { get; private set; }

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Apply();
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "could not apply browser policy");
                Summary = $"failed: {ex.Message}";
            }
            try
            {
                await Task.Delay(Reconcile, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>Brings the machine in line with the settings. Safe to call at any time.</summary>
    public void Apply()
    {
        if (!OperatingSystem.IsWindows()) return;
        var settings = store.Settings;
        var applied = 0;
        var removed = 0;

        foreach (var (name, root) in PolicyPlan.Browsers)
        {
            var wanted = PolicyPlan.For(settings, _extensionId, name);
            var owned = PolicyPlan.AllOwned(_extensionId);

            // Remove anything we own that shouldn't be there now. Doing this first means
            // turning enforcement off genuinely restores the browser rather than leaving
            // half a policy behind.
            foreach (var value in owned.Where(o => !wanted.Any(w => w.SubKey == o.SubKey && w.Name == o.Name)))
                removed += Remove(root, value) ? 1 : 0;

            foreach (var value in wanted)
                applied += Write(root, value) ? 1 : 0;
        }

        Applied = settings.Enforce;
        Summary = settings.Enforce
            ? $"enforced for {PolicyPlan.Browsers.Length} browsers"
            : "not enforced";
        if (applied + removed > 0)
        {
            var note = $"browser policy updated ({applied} set, {removed} cleared) — {Summary}";
            if (note != _lastSummary)
            {
                log.LogInformation("{Note}", note);
                store.Note(note);
                _lastSummary = note;
            }
        }
    }

    private bool Write(string root, PolicyValue value)
    {
        var path = string.IsNullOrEmpty(value.SubKey) ? root : $@"{root}\{value.SubKey}";
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(path, writable: true);
            if (key is null) return false;
            var existing = key.GetValue(value.Name);
            if (existing is not null && existing.Equals(value.Value)) return false; // already right
            key.SetValue(value.Name, value.Value, value.IsDword ? RegistryValueKind.DWord : RegistryValueKind.String);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            Summary = "needs admin rights (run as the installed service)";
            return false;
        }
    }

    /// <summary>
    /// Takes a value back out. Values shared with the installer are put back to their
    /// released state instead of deleted; a subkey we emptied is removed so Chrome isn't
    /// left reading an empty dictionary entry.
    /// </summary>
    private static bool Remove(string root, PolicyValue value)
    {
        var path = string.IsNullOrEmpty(value.SubKey) ? root : $@"{root}\{value.SubKey}";
        try
        {
            using (var key = Registry.LocalMachine.OpenSubKey(path, writable: true))
            {
                var existing = key?.GetValue(value.Name);
                if (key is null || existing is null) return false;
                if (value.Released is not null)
                {
                    if (existing.Equals(value.Released)) return false;
                    key.SetValue(value.Name, value.Released, RegistryValueKind.String);
                    return true;
                }
                key.DeleteValue(value.Name, throwOnMissingValue: false);
                if (string.IsNullOrEmpty(value.SubKey) || key.ValueCount > 0 || key.SubKeyCount > 0) return true;
            }
            Registry.LocalMachine.DeleteSubKey(path, throwOnMissingSubKey: false);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Reads back what is actually in the registry, for doctor and the GUI.</summary>
    public IReadOnlyList<Check> Inspect()
    {
        var checks = new List<Check>();
        if (!OperatingSystem.IsWindows()) return checks;
        var settings = store.Settings;

        foreach (var (name, root) in PolicyPlan.Browsers)
        {
            var wanted = PolicyPlan.For(settings, _extensionId, name);
            if (wanted.Count == 0) continue;
            var missing = wanted.Where(v => !Matches(root, v)).Select(v => string.IsNullOrEmpty(v.SubKey) ? v.Name : $@"{v.SubKey}\{v.Name}").ToList();
            checks.Add(new Check($"{name} policy", missing.Count == 0,
                missing.Count == 0 ? "force-installed and locked down" : $"missing: {string.Join(", ", missing)}",
                Fix: "The service reapplies policy every 30 seconds; check it is running as SYSTEM"));
        }
        return checks;
    }

    private static bool Matches(string root, PolicyValue value)
    {
        var path = string.IsNullOrEmpty(value.SubKey) ? root : $@"{root}\{value.SubKey}";
        using var key = Registry.LocalMachine.OpenSubKey(path);
        return key?.GetValue(value.Name)?.Equals(value.Value) == true;
    }
}
