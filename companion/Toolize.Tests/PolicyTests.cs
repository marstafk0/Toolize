using Toolize.Core;
using Xunit;

namespace Toolize.Tests;

/// <summary>
/// Which changes count as weakening. Getting this wrong is how a lock quietly stops
/// locking, so each direction is pinned down explicitly.
/// </summary>
public sealed class SettingsPolicyTests
{
    private static readonly Settings Base = Settings.Default;

    [Fact]
    public void Turning_protection_off_is_weakening()
    {
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { Enabled = false }));
        Assert.False(SettingsPolicy.IsWeakening(Base with { Enabled = false }, Base));
    }

    [Theory]
    [InlineData(Preset.Strict, Preset.Balanced, true)]
    [InlineData(Preset.Balanced, Preset.Relaxed, true)]
    [InlineData(Preset.Relaxed, Preset.Strict, false)]
    [InlineData(Preset.Balanced, Preset.Balanced, false)]
    public void Lowering_sensitivity_is_weakening(Preset from, Preset to, bool weakening) =>
        Assert.Equal(weakening, SettingsPolicy.IsWeakening(Base with { Preset = from }, Base with { Preset = to }));

    [Fact]
    public void Safe_reveal_to_detect_then_blur_is_weakening()
    {
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { Mode = RevealMode.Fast }));
        Assert.False(SettingsPolicy.IsWeakening(Base with { Mode = RevealMode.Fast }, Base));
    }

    [Fact]
    public void Turning_off_site_blocking_is_weakening() =>
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { BlockAdultSites = false }));

    [Fact]
    public void Weakenings_are_listed_for_the_user()
    {
        var reasons = SettingsPolicy.Weakenings(Base, Base with { Enabled = false, BlockAdultSites = false });
        Assert.Contains("turning protection off", reasons);
        Assert.Contains("turning off adult-site blocking", reasons);
    }
}

public sealed class SecretsTests
{
    [Fact]
    public void Recovery_codes_are_readable_and_unambiguous()
    {
        var code = Secrets.NewRecoveryCode();
        Assert.Matches("^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$", code);
        Assert.DoesNotContain('O', code); // no characters that get misread when written down
        Assert.DoesNotContain('I', code);
    }

    [Fact]
    public void Recovery_codes_normalise_to_the_same_value_however_they_are_typed()
    {
        var code = Secrets.NewRecoveryCode();
        Assert.Equal(Secrets.Normalise(code), Secrets.Normalise(code.ToLowerInvariant().Replace("-", " ")));
    }

    [Fact]
    public void Secrets_are_random_and_hash_stably()
    {
        var a = Secrets.NewSecret();
        Assert.NotEqual(a, Secrets.NewSecret());
        Assert.Equal(Secrets.Hash(a), Secrets.Hash(a));
        Assert.NotEqual(Secrets.Hash(a), Secrets.Hash(Secrets.NewSecret()));
    }
}

public sealed class StateStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "toolize-state", Guid.NewGuid().ToString("n")[..8]);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Settings_and_keys_survive_a_restart()
    {
        var store = new StateStore(_dir);
        store.UpdateSettings(Settings.Default with { Preset = Preset.Strict });
        store.AddKey(new EnrolledKey { Id = "abc", Name = "key", SecretHash = "hash", Counter = 1 });

        var reopened = new StateStore(_dir);
        Assert.Equal(Preset.Strict, reopened.Settings.Preset);
        Assert.Single(reopened.Keys);
        Assert.Equal("key", reopened.Keys[0].Name);
    }

    [Fact]
    public void A_corrupt_state_file_falls_back_to_protective_defaults()
    {
        var store = new StateStore(_dir);
        store.UpdateSettings(Settings.Default with { Enabled = false });
        File.WriteAllText(Path.Combine(_dir, "state.dat"), "this is not encrypted json");

        var reopened = new StateStore(_dir);
        Assert.True(reopened.Settings.Enabled); // fail safe, not fail open
        Assert.Contains(reopened.Notes, n => n.Contains("unreadable"));
    }

    [Fact]
    public void A_recovery_code_works_once_and_clears_the_keys()
    {
        var store = new StateStore(_dir);
        store.AddKey(new EnrolledKey { Id = "abc", Name = "key", SecretHash = "hash", Counter = 1 });
        var code = Secrets.NewRecoveryCode();
        store.SetRecoveryCode(code);

        Assert.False(store.UseRecoveryCode("WRONG-CODE-HERE-XXXXX"));
        Assert.True(store.HasRecoveryCode);

        Assert.True(store.UseRecoveryCode(code.ToLowerInvariant()));
        Assert.Empty(store.Keys);
        Assert.False(store.HasRecoveryCode);
        Assert.False(store.UseRecoveryCode(code)); // burned
    }
}

public sealed class ExtensionTrackerAndRevisionTests
{
    [Fact]
    public void Heartbeats_from_multiple_browsers_sum_counters_and_track_each_browser()
    {
        var tracker = new Toolize.Service.ExtensionTracker();
        var storeId = Toolize.Service.AppInfo.StoreExtensionId;

        tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", Blocked: 4, Checked: 100, Browser: "chrome", ExtensionId: storeId));
        tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", Blocked: 7, Checked: 250, Browser: "brave", ExtensionId: "devid123"));

        var state = tracker.State;
        Assert.True(state.Connected);
        Assert.Equal(11, state.Blocked);
        Assert.Equal(350, state.Checked);
        Assert.Equal(["brave (dev build)", "chrome"], state.Browsers);
        Assert.Equal(2, state.ConnectedBrowsers.Count);

        // Next Chrome heartbeat updates Chrome's entry without wiping Brave's.
        tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", Blocked: 6, Checked: 120, Browser: "chrome", ExtensionId: storeId));
        state = tracker.State;
        Assert.Equal(13, state.Blocked);
        Assert.Equal(370, state.Checked);

        // IsConnected requires an explicit browser match (no empty-browser wildcard).
        Assert.True(tracker.IsConnected("chrome", storeId));
        Assert.False(tracker.IsConnected("edge", storeId));
        tracker.Hello("0.9.0", null, storeId);
        Assert.False(tracker.IsConnected("edge", storeId));
    }

    [Fact]
    public async Task Watch_returns_immediately_when_behind_and_wakes_on_settings_change()
    {
        var tracker = new Toolize.Service.ExtensionTracker();
        var initial = tracker.Revision;
        Assert.Equal(1, initial);

        // Behind revision -> returns immediately.
        var behind = await tracker.WatchAsync(0, CancellationToken.None, TimeSpan.FromSeconds(5));
        Assert.True(behind.Accepted);
        Assert.Equal(initial, behind.Revision);

        // Caught up -> holds until SettingsChanged() bumps the revision.
        var watchTask = tracker.WatchAsync(initial, CancellationToken.None, TimeSpan.FromSeconds(5));
        Assert.False(watchTask.IsCompleted);

        var next = tracker.SettingsChanged();
        var held = await watchTask;
        Assert.True(held.Accepted);
        Assert.Equal(next, held.Revision);
        Assert.Equal(2, held.Revision);
    }

    [Fact]
    public async Task Watch_returns_current_revision_when_hold_times_out_and_caps_watchers()
    {
        var tracker = new Toolize.Service.ExtensionTracker();
        var rev = tracker.Revision;

        var timedOut = await tracker.WatchAsync(rev, CancellationToken.None, TimeSpan.FromMilliseconds(30));
        Assert.True(timedOut.Accepted);
        Assert.Equal(rev, timedOut.Revision);

        // Cap at MaxWatchers (16).
        using var cts = new CancellationTokenSource();
        var tasks = Enumerable.Range(0, Toolize.Service.ExtensionTracker.MaxWatchers)
            .Select(_ => tracker.WatchAsync(rev, cts.Token, TimeSpan.FromSeconds(10)))
            .ToList();
        Assert.Equal(Toolize.Service.ExtensionTracker.MaxWatchers, tracker.ActiveWatchers);

        var overflow = await tracker.WatchAsync(rev, CancellationToken.None, TimeSpan.FromSeconds(1));
        Assert.False(overflow.Accepted);

        tracker.SettingsChanged();
        await Task.WhenAll(tasks);
        Assert.Equal(0, tracker.ActiveWatchers);
    }

    [Fact]
    public async Task ReadBoundedLine_enforces_maximum_length()
    {
        using var okStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes("{\"verb\":\"status\"}\r\n"));
        var line = await Toolize.Service.PipeServer.ReadBoundedLineAsync(okStream, 64, CancellationToken.None);
        Assert.Equal("{\"verb\":\"status\"}", line);

        using var bigStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(new string('x', 100) + "\n"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            Toolize.Service.PipeServer.ReadBoundedLineAsync(bigStream, 32, CancellationToken.None));
    }

    [Fact]
    public async Task PipeServer_holds_watch_settings_without_blocking_other_clients_and_pushes_on_change()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "toolize-pipe-test-" + Guid.NewGuid().ToString("n")[..8]);
        var pipeName = "toolize-test-" + Guid.NewGuid().ToString("n")[..8];
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            var store = new StateStore(tempDir);
            var locks = new Toolize.Service.LockService();
            var tracker = new Toolize.Service.ExtensionTracker();
            var unlock = new Toolize.Service.UnlockService(store, locks, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.UnlockService>.Instance, tracker);
            var enforcement = new Toolize.Service.EnforcementService(store, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.EnforcementService>.Instance, dev: true);
            var watchdog = new Toolize.Service.WatchdogService(store, tracker, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.WatchdogService>.Instance, dev: true);
            var updates = new Toolize.Service.UpdateService(store, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.UpdateService>.Instance);
            var doctor = new Toolize.Service.DoctorService(store, tracker, locks, enforcement);
            var handler = new Toolize.Service.RequestHandler(store, locks, unlock, enforcement, watchdog, updates, tracker, doctor, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.RequestHandler>.Instance);
            var server = new Toolize.Service.PipeServer(pipeName, handler, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.PipeServer>.Instance);

            var serverTask = server.RunAsync(cts.Token);
            var client = new PipeClient(pipeName);

            // 1. Hello returns initial revision 1.
            var hello = await client.SendAsync(Verbs.ExtensionHello, new ExtensionHelloArgs("0.9.0", "chrome", "id1"), cts.Token);
            Assert.True(hello.Ok);
            Assert.Equal(1, hello.Data!.Value.GetProperty("revision").GetInt32());

            // 2. Start a long-poll watch-settings with revision 1; it should hold.
            var watchTask = client.SendAsync(Verbs.WatchSettings, new WatchSettingsArgs(1), cts.Token);
            await Task.Delay(100, cts.Token);
            Assert.False(watchTask.IsCompleted);

            // 3. Another client call (status) succeeds while watch-settings is held.
            var status = await client.SendAsync(Verbs.Status, null, cts.Token);
            Assert.True(status.Ok);

            // 4. Changing settings bumps the revision and wakes watchTask immediately.
            var setResp = await client.SendAsync(Verbs.SetSettings, new SetSettingsArgs(Settings.Default with { Preset = Preset.Strict }), cts.Token);
            Assert.True(setResp.Ok);

            var watchResp = await watchTask;
            Assert.True(watchResp.Ok);
            Assert.Equal(2, watchResp.Data!.Value.GetProperty("revision").GetInt32());
            Assert.Equal("strict", watchResp.Data!.Value.GetProperty("settings").GetProperty("preset").GetString());

            cts.Cancel();
            await serverTask;
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task Doctor_reports_per_browser_settings_sync_and_warns_on_dev_pipe()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "toolize-doctor-test-" + Guid.NewGuid().ToString("n")[..8]);
        try
        {
            var store = new StateStore(tempDir);
            var locks = new Toolize.Service.LockService();
            var tracker = new Toolize.Service.ExtensionTracker();
            var enforcement = new Toolize.Service.EnforcementService(store, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.EnforcementService>.Instance, dev: true);
            var storeId = Toolize.Service.AppInfo.StoreExtensionId;

            // Both browsers check in after SettingsChangedAt -> Settings sync is Ok.
            tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", 0, 10, "chrome", storeId));
            tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", 0, 10, "edge", storeId));

            var doctorSynced = new Toolize.Service.DoctorService(store, tracker, locks, enforcement, dev: false, devPipeExists: () => true);
            var checksSynced = await doctorSynced.RunAsync(CancellationToken.None);

            var syncCheck = Assert.Single(checksSynced.Where(c => c.Name == "Settings sync"));
            Assert.True(syncCheck.Ok);
            Assert.Contains("chrome, edge", syncCheck.Detail);

            var devWarn = Assert.Single(checksSynced.Where(c => c.Name == "Dev instance"));
            Assert.True(devWarn.Ok); // warn only — never fails the doctor check
            Assert.Contains("warning:", devWarn.Detail);

            // Bump settings so only chrome checks in afterwards -> edge is reported as behind.
            await Task.Delay(15);
            tracker.SettingsChanged();
            await Task.Delay(15);
            tracker.Heartbeat(new ExtensionHeartbeatArgs("0.9.0", 0, 12, "chrome", storeId));

            var checksBehind = await doctorSynced.RunAsync(CancellationToken.None);
            var behindCheck = Assert.Single(checksBehind.Where(c => c.Name == "Settings sync"));
            Assert.False(behindCheck.Ok);
            Assert.Contains("edge", behindCheck.Detail);
            Assert.DoesNotContain("chrome", behindCheck.Detail);

            // When the service itself is a dev instance, it does not warn about the dev pipe.
            var doctorDev = new Toolize.Service.DoctorService(store, tracker, locks, enforcement, dev: true, devPipeExists: () => true);
            var checksDev = await doctorDev.RunAsync(CancellationToken.None);
            Assert.DoesNotContain(checksDev, c => c.Name == "Dev instance");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task RequestHandler_gates_issue_recovery_on_unlock_and_allows_set_channel_while_locked()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "toolize-handler-test-" + Guid.NewGuid().ToString("n")[..8]);
        try
        {
            var store = new StateStore(tempDir);
            store.AddKey(new EnrolledKey { Id = "k1", Name = "key", SecretHash = "hash", Counter = 1 });
            var locks = new Toolize.Service.LockService();
            var tracker = new Toolize.Service.ExtensionTracker();
            var unlock = new Toolize.Service.UnlockService(store, locks, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.UnlockService>.Instance, tracker);
            var enforcement = new Toolize.Service.EnforcementService(store, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.EnforcementService>.Instance, dev: true);
            var watchdog = new Toolize.Service.WatchdogService(store, tracker, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.WatchdogService>.Instance, dev: true);
            var updates = new Toolize.Service.UpdateService(store, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.UpdateService>.Instance);
            var doctor = new Toolize.Service.DoctorService(store, tracker, locks, enforcement, dev: true);
            var handler = new Toolize.Service.RequestHandler(store, locks, unlock, enforcement, watchdog, updates, tracker, doctor, Microsoft.Extensions.Logging.Abstractions.NullLogger<Toolize.Service.RequestHandler>.Instance);

            // Key is enrolled and absent (locked): issuing a recovery code is refused.
            var issueLocked = await handler.HandleAsync(new Request(Verbs.IssueRecovery), CancellationToken.None);
            Assert.False(issueLocked.Ok);
            Assert.Equal("locked", issueLocked.Code);

            // Switching channel is allowed even while locked.
            var setChan = await handler.HandleAsync(new Request(Verbs.SetChannel)
            {
                Args = System.Text.Json.JsonSerializer.SerializeToElement(new SetChannelArgs("dev"), Protocol.Json),
            }, CancellationToken.None);
            Assert.True(setChan.Ok);
            Assert.Equal("dev", store.Channel);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }
}
