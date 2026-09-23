using Microsoft.Extensions.Logging;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// Decides, continuously, whether an enrolled key is plugged in.
///
/// Key presence *is* the unlock state: no timers, no unlock windows. Pull the key out
/// and the next poll re-locks, which is why the poll is frequent and why every
/// weakening operation re-checks at the moment it commits rather than trusting a flag
/// set seconds ago.
///
/// Polling rather than device-arrival notifications: a service has no message pump, USB
/// arrival events are duplicated and racy, and a one-second poll is both simpler and
/// harder to fool than a cached "it was there a moment ago".
/// </summary>
public sealed class UnlockService(StateStore store, LockService locks, ILogger<UnlockService> log)
{
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(1);
    /// <summary>How often a present key is re-proved by rotating its secret.</summary>
    private static readonly TimeSpan RotateEvery = TimeSpan.FromSeconds(60);

    // TOOLIZE_FAKE_DRIVES points the provider at folders instead of real USB drives, so
    // the lock can be exercised end to end (including the service, pipe and GUI) without
    // writing to anybody's actual stick. Dev builds only.
    private readonly IUnlockProvider _flash = Environment.GetEnvironmentVariable("TOOLIZE_FAKE_DRIVES") is { Length: > 0 } fake
        ? new FlashDriveProvider(() =>
        [
            .. fake.Split(';', StringSplitOptions.RemoveEmptyEntries)
                .Where(Directory.Exists)
                .Select(path => new DriveOption(
                    path.EndsWith(Path.DirectorySeparatorChar) ? path : path + Path.DirectorySeparatorChar,
                    $"simulated ({Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar))})",
                    4_000_000_000,
                    File.Exists(FlashDriveProvider.KeyPath(path)))),
        ])
        : new FlashDriveProvider();
    private readonly object _gate = new();
    private DateTimeOffset _lastRotation = DateTimeOffset.MinValue;
    private UnlockStatus _last = UnlockStatus.Absent;

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Refresh();
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "unlock check failed");
                locks.Update(Locked("the key check failed"));  // fail safe
            }
            try
            {
                await Task.Delay(Poll, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>
    /// Re-checks right now. Called by the poll loop and again by anything about to act on
    /// the answer, so a key removed a moment ago can't authorise anything.
    /// </summary>
    public LockState Refresh()
    {
        lock (_gate)
        {
            var keys = store.Keys;
            if (keys.Count == 0)
            {
                _last = UnlockStatus.Absent;
                var none = new LockState { Enrolled = false, KeyPresent = false };
                locks.Update(none);
                return none;
            }

            var check = _flash.Check(keys);
            var state = check.Status switch
            {
                UnlockStatus.Verified => new LockState { Enrolled = true, KeyPresent = true, KeyName = check.Key!.Name },
                _ => Locked(check.Detail),
            };

            if (check.Status != _last)
            {
                switch (check.Status)
                {
                    case UnlockStatus.Verified:
                        log.LogInformation("unlocked by {Key}", check.Key!.Name);
                        store.Note($"unlocked by key '{check.Key.Name}'");
                        break;
                    case UnlockStatus.Absent when _last == UnlockStatus.Verified:
                        log.LogInformation("key removed — locked");
                        store.Note("key removed, re-locked");
                        break;
                    case UnlockStatus.Clone:
                        // The one thing Tier A can actually prove: two copies exist.
                        log.LogWarning("clone detected: {Detail}", check.Detail);
                        store.Note($"COPY DETECTED: {check.Detail}");
                        break;
                    case UnlockStatus.Invalid:
                        store.Note($"key rejected: {check.Detail}");
                        break;
                }
                _last = check.Status;
            }

            // Rotating while present is what makes an older copy detectable later.
            if (check.Status == UnlockStatus.Verified && DateTimeOffset.UtcNow - _lastRotation > RotateEvery)
            {
                _lastRotation = DateTimeOffset.UtcNow;
                try
                {
                    store.UpdateKey(_flash.Rotate(check.Key!));
                }
                catch (Exception ex)
                {
                    log.LogWarning(ex, "could not rotate the key secret");
                }
            }

            locks.Update(state);
            return state;
        }
    }

    private static LockState Locked(string? detail) =>
        new() { Enrolled = true, KeyPresent = false, KeyName = detail };

    // ---------------------------------------------------------------- enrollment

    public IReadOnlyList<DriveOption> Drives() => _flash.Available();

    /// <summary>
    /// Enrolls a drive. The first key may be enrolled freely; enrolling another is a
    /// weakening change, so it needs a key already present.
    /// </summary>
    public EnrolledKey Enroll(string drive, string name)
    {
        lock (_gate)
        {
            if (store.Keys.Count > 0 && !Refresh().CanWeaken)
                throw new InvalidOperationException("plug in an enrolled key before adding another one");

            var key = _flash.Enroll(drive, name);
            store.AddKey(key);
            store.Note($"enrolled key '{name}' on {drive}");
            _last = UnlockStatus.Absent; // force a fresh verification pass
            Refresh();
            return key;
        }
    }

    public bool Revoke(string id)
    {
        lock (_gate)
        {
            if (!Refresh().CanWeaken) throw new InvalidOperationException("plug in an enrolled key to remove one");
            var removed = store.RemoveKey(id);
            if (removed) store.Note($"revoked key {id}");
            Refresh();
            return removed;
        }
    }

    /// <summary>
    /// The way back in when every key is lost. Burns the code and drops all enrolled
    /// keys, leaving protection on but unlocked, ready for a fresh enrollment.
    /// </summary>
    public bool Recover(string code)
    {
        lock (_gate)
        {
            var ok = store.UseRecoveryCode(code);
            store.Note(ok ? "recovery code used — all keys cleared" : "recovery code rejected");
            Refresh();
            return ok;
        }
    }

    public string IssueRecoveryCode()
    {
        var code = Secrets.NewRecoveryCode();
        store.SetRecoveryCode(code);
        store.Note("recovery code issued");
        return code; // shown once, stored only as a hash
    }
}
