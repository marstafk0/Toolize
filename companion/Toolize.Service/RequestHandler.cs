using Microsoft.Extensions.Logging;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// The decision point. Clients propose; this class disposes.
///
/// The rule that matters: strengthening changes are always allowed, weakening changes
/// are refused unless a verified key is present. Phase 3 has no key enrolled, so nothing
/// is refused yet — but every weakening still passes through this gate, so phase 4 only
/// has to make <see cref="LockService"/> tell the truth.
/// </summary>
public sealed class RequestHandler(
    StateStore store,
    LockService locks,
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
                Verbs.ApplyUpdate => await ApplyUpdateAsync(request, ct),
                Verbs.Doctor => Response.Success(request.Id, await doctor.RunAsync(ct)),
                Verbs.ExtensionHello => ExtensionHello(request),
                Verbs.ExtensionHeartbeat => ExtensionHeartbeat(request),
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
        Notes = store.Notes.TakeLast(20).ToList(),
    };

    private Response SetSettings(Request request)
    {
        var args = request.ArgsAs<SetSettingsArgs>();
        if (args?.Settings is null) return Response.Failure(request.Id, "no settings supplied", "bad-request");

        var before = store.Settings;
        var after = args.Settings;
        if (SettingsPolicy.IsWeakening(before, after) && !locks.State.CanWeaken)
        {
            var what = string.Join(", ", SettingsPolicy.Weakenings(before, after));
            store.Note($"refused while locked: {what}");
            return Response.Failure(request.Id, $"the unlock key must be plugged in to allow {what}", "locked");
        }

        var saved = store.UpdateSettings(after);
        if (SettingsPolicy.IsWeakening(before, after))
            store.Note($"weakened: {string.Join(", ", SettingsPolicy.Weakenings(before, after))}");
        extension.SettingsChanged();
        return Response.Success(request.Id, saved);
    }

    private async Task<Response> ApplyUpdateAsync(Request request, CancellationToken ct)
    {
        // Updating is neither strengthening nor weakening, but it does replace the
        // binaries, so it is refused while locked once a key is enrolled.
        if (!locks.State.CanWeaken)
            return Response.Failure(request.Id, "the unlock key must be plugged in to update", "locked");
        var result = await updates.ApplyAsync(ct);
        return result.Ok ? Response.Success(request.Id, result) : Response.Failure(request.Id, result.Message);
    }

    private Response ExtensionHello(Request request)
    {
        var args = request.ArgsAs<ExtensionHelloArgs>();
        extension.Hello(args?.Version);
        log.LogInformation("extension {Version} connected", args?.Version);
        return Response.Success(request.Id, new { settings = store.Settings, service = AppInfo.Version });
    }

    private Response ExtensionHeartbeat(Request request)
    {
        var args = request.ArgsAs<ExtensionHeartbeatArgs>();
        if (args is not null) extension.Heartbeat(args);
        return Response.Success(request.Id, new { settings = store.Settings });
    }
}
