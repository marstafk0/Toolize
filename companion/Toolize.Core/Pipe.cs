using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Toolize.Core;

/// <summary>
/// Named-pipe transport. Any interactive user may connect — the pipe is a remote
/// control, not a secret. What a caller may *do* is decided by the service.
/// </summary>
public static class Pipe
{
    public static PipeSecurity ServerSecurity()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        if (WindowsIdentity.GetCurrent().User is { } currentUser)
        {
            security.AddAccessRule(new PipeAccessRule(
                currentUser, PipeAccessRights.FullControl, AccessControlType.Allow));
        }
        return security;
    }
}

/// <summary>Client side: connect, ask, disconnect. Every call is independent.</summary>
public sealed class PipeClient(string pipeName)
{
    public async Task<Response> SendAsync(Request request, CancellationToken ct = default, int timeoutMs = 5000, int? readTimeoutMs = null)
    {
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(timeoutMs, ct);
        using var reader = new StreamReader(pipe, leaveOpen: true);
        await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };

        await writer.WriteLineAsync(JsonSerializer.Serialize(request, Protocol.Json));
        string? line;
        if (readTimeoutMs is { } ms)
        {
            using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            readCts.CancelAfter(ms);
            line = await reader.ReadLineAsync(readCts.Token);
        }
        else
        {
            line = await reader.ReadLineAsync(ct);
        }
        if (line is null) throw new IOException("service closed the connection");
        return JsonSerializer.Deserialize<Response>(line, Protocol.Json)
               ?? throw new IOException("unreadable response from service");
    }

    public async Task<Response> SendAsync(string verb, object? args = null, CancellationToken ct = default, int timeoutMs = 5000, int? readTimeoutMs = null)
    {
        var request = new Request(verb)
        {
            Args = args is null ? null : JsonSerializer.SerializeToElement(args, Protocol.Json),
        };
        return await SendAsync(request, ct, timeoutMs, readTimeoutMs);
    }

    /// <summary>True when the service is running and answering.</summary>
    public async Task<bool> IsRunningAsync(CancellationToken ct = default)
    {
        try
        {
            return (await SendAsync(Verbs.Status, null, ct)).Ok;
        }
        catch
        {
            return false;
        }
    }
}
