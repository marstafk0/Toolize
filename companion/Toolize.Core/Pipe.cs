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
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }
}

/// <summary>Client side: connect, ask, disconnect. Every call is independent.</summary>
public sealed class PipeClient(string pipeName)
{
    public async Task<Response> SendAsync(Request request, CancellationToken ct = default, int timeoutMs = 5000)
    {
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(timeoutMs, ct);
        using var reader = new StreamReader(pipe, leaveOpen: true);
        await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };

        await writer.WriteLineAsync(JsonSerializer.Serialize(request, Protocol.Json));
        var line = await reader.ReadLineAsync(ct) ?? throw new IOException("service closed the connection");
        return JsonSerializer.Deserialize<Response>(line, Protocol.Json)
               ?? throw new IOException("unreadable response from service");
    }

    public async Task<Response> SendAsync(string verb, object? args = null, CancellationToken ct = default)
    {
        var request = new Request(verb)
        {
            Args = args is null ? null : JsonSerializer.SerializeToElement(args, Protocol.Json),
        };
        return await SendAsync(request, ct);
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
