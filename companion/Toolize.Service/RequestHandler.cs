using System.Text.Json;
using Microsoft.Extensions.Logging;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// The decision point. Clients propose; this class disposes.
///
/// The rule that matters: strengthening changes are always allowed, weakening changes
/// are refused unless a verified key is present. Presence is re-checked at the moment of
/// the decision, never read from a cached flag — pulling the key out must take effect
/// immediately, even mid-operation.
/// </summary>
public sealed class RequestHandler(
    StateStore store,
    LockService locks,
    UnlockService unlock,
    EnforcementService enforcement,
    WatchdogService watchdog,
    UpdateService updates,
    ExtensionTracker extension,
    DoctorService doctor,
    ILogger<RequestHandler> log)
{
    public async Task<Response> HandleAsync(Request request, CancellationToken ct)
    {
        try
        {
            return request.Verb switch
            {
                Verbs.Status => Response.Success(request.Id, BuildStatus()),
                Verbs.GetSettings => Response.Success(request.Id, store.Settings),
                Verbs.SetSettings => SetSettings(request),
                Verbs.CheckUpdate => Response.Success(request.Id, await updates.CheckAsync(ct)),
                Verbs.SetChannel => await SetChannelAsync(request, ct),
                Verbs.ApplyUpdate => await ApplyUpdateAsync(request, ct),
                Verbs.Doctor => Response.Success(request.Id, await doctor.RunAsync(ct)),
                Verbs.Drives => Response.Success(request.Id, unlock.Drives()),
                Verbs.EnrollKey => EnrollKey(request),
                Verbs.RevokeKey => RevokeKey(request),
                Verbs.Recover => Recover(request),
                Verbs.IssueRecovery => Response.Success(request.Id, new { code = unlock.IssueRecoveryCode() }),
                Verbs.ExtensionHello => ExtensionHello(request),
                Verbs.ExtensionHeartbeat => ExtensionHeartbeat(request),
                Verbs.AuthorizeWeakening => AuthorizeWeakening(request),
                _ => Response.Failure(request.Id, $"unknown verb '{request.Verb}'", "unknown-verb"),
            };
        }
        catch (Exception ex)
        {
            log.LogError(ex, "verb {Verb} failed", request.Verb);
            return Response.Failure(request.Id, ex.Message);
        }
    }

    private StatusReport BuildStatus() => new()
    {
        Version = AppInfo.Version,
        Channel = store.Channel ?? "stable",
        Settings = store.Settings,
        Lock = locks.State,
        Extension = extension.State,
        Update = updates.Last,
        Keys = store.Keys,
        Enforcement = new EnforcementState
        {
            Applied = enforcement.Applied,
            Summary = enforcement.Summary,
            Watchdog = watchdog.Status,
        },
        HasRecoveryCode = store.HasRecoveryCode,
        Notes = store.Notes.TakeLast(20).ToList(),
    };

    private Response SetSettings(Request request)
    {
        if (request.Args is not { } args
            || !args.TryGetProperty("settings", out var patch)
            || patch.ValueKind != JsonValueKind.Object)
            return Response.Failure(request.Id, "no settings supplied", "bad-request");

        var before = store.Settings;
        // Overlay, don't replace: a client that doesn't know a setting must not reset it.
        var after = SettingsPolicy.Overlay(before, patch);
        // Re-check the key at the moment of the decision. A key pulled out a second ago
        // must not authorise anything, so the cached state is never good enough here.
        if (SettingsPolicy.IsWeakening(before, after) && !unlock.Refresh().CanWeaken)
        {
            var what = string.Join(", ", SettingsPolicy.Weakenings(before, after));
            store.Note($"refused while locked: {what}");
            return Response.Failure(request.Id, $"the unlock key must be plugged in to allow {what}", "locked");
        }

        var saved = store.UpdateSettings(after);
        if (SettingsPolicy.IsWeakening(before, after))
            store.Note($"weakened: {string.Join(", ", SettingsPolicy.Weakenings(before, after))}");
        extension.SettingsChanged();
        // Don't wait for the next reconcile: the user should see the browser change now.
        enforcement.Apply();
        return Response.Success(request.Id, saved);
    }

    /// <summary>Channel choice decides which releases this machine is offered.</summary>
    private async Task<Response> SetChannelAsync(Request request, CancellationToken ct)
    {
        var channel = request.ArgsAs<SetChannelArgs>()?.Channel?.ToLowerInvariant();
        if (channel is not ("stable" or "dev"))
            return Response.Failure(request.Id, "channel must be 'stable' or 'dev'", "bad-request");
        store.SetChannel(channel);
        store.Note($"channel set to {channel}");
        return Response.Success(request.Id, await updates.CheckAsync(ct));
    }

    private Response AuthorizeWeakening(Request request)
    {
        // Content-free by contract: the log says that something was unblocked, never what.
        var what = request.ArgsAs<AuthorizeWeakeningArgs>()?.What;
        if (string.IsNullOrWhiteSpace(what) || what.Length > 80 || what.Contains("://"))
            return Response.Failure(request.Id, "describe the change in a few words", "bad-request");
        if (!unlock.Refresh().CanWeaken)
        {
            store.Note($"refused while locked: {what}");
            return Response.Failure(request.Id, $"the unlock key must be plugged in to allow {what}", "locked");
        }
        store.Note($"weakened: {what}");
        return Response.Success(request.Id, new { allowed = true });
    }

    private async Task<Response> ApplyUpdateAsync(Request request, CancellationToken ct)
    {
        // Updating is neither strengthening nor weakening, but it does replace the
        // binaries, so it is refused while locked once a key is enrolled.
        if (!unlock.Refresh().CanWeaken)
            return Response.Failure(request.Id, "the unlock key must be plugged in to update", "locked");
        var result = await updates.ApplyAsync(ct);
        return result.Ok ? Response.Success(request.Id, result) : Response.Failure(request.Id, result.Message);
    }

    private Response EnrollKey(Request request)
    {
        var args = request.ArgsAs<EnrollKeyArgs>();
        if (args is null || string.IsNullOrWhiteSpace(args.Drive))
            return Response.Failure(request.Id, "which drive?", "bad-request");
        try
        {
            var key = unlock.Enroll(args.Drive, string.IsNullOrWhiteSpace(args.Name) ? "USB key" : args.Name);
            // First key: issue the recovery code now, while the user is paying attention.
            var recovery = store.Keys.Count == 1 && !store.HasRecoveryCode ? unlock.IssueRecoveryCode() : null;
            return Response.Success(request.Id, new { key, recovery });
        }
        catch (InvalidOperationException ex)
        {
            return Response.Failure(request.Id, ex.Message, "locked");
        }
    }

    private Response RevokeKey(Request request)
    {
        var id = request.ArgsAs<RevokeKeyArgs>()?.Id;
        if (id is null) return Response.Failure(request.Id, "which key?", "bad-request");
        try
        {
            return unlock.Revoke(id)
                ? Response.Success(request.Id, new { removed = id })
                : Response.Failure(request.Id, $"no key with id {id}", "not-found");
        }
        catch (InvalidOperationException ex)
        {
            return Response.Failure(request.Id, ex.Message, "locked");
        }
    }

    private Response Recover(Request request)
    {
        var code = request.ArgsAs<RecoverArgs>()?.Code;
        if (string.IsNullOrWhiteSpace(code)) return Response.Failure(request.Id, "no code supplied", "bad-request");
        return unlock.Recover(code)
            ? Response.Success(request.Id, new { recovered = true })
            : Response.Failure(request.Id, "that recovery code isn't valid, or it has already been used", "bad-code");
    }

    private Response ExtensionHello(Request request)
    {
        var args = request.ArgsAs<ExtensionHelloArgs>();
        extension.Hello(args?.Version, args?.Browser, args?.ExtensionId);
        log.LogInformation("extension {Version} connected from {Browser}", args?.Version, args?.Browser ?? "an unknown browser");
        return Response.Success(request.Id, new { settings = store.Settings, service = AppInfo.Version, enforced = store.Settings.Enforce });
    }

    private Response ExtensionHeartbeat(Request request)
    {
        var args = request.ArgsAs<ExtensionHeartbeatArgs>();
        if (args is not null) extension.Heartbeat(args);
        return Response.Success(request.Id, new { settings = store.Settings, enforced = store.Settings.Enforce });
    }
}
