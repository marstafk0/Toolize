using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Toolize.Core;

namespace Toolize.Service;

/// <summary>
/// Accepts client connections and hands each request to the dispatcher. One connection
/// per request keeps the state machine trivial: there is no session, so there is no
/// session to hijack, and a client that dies mid-call leaves nothing behind.
/// </summary>
public sealed class PipeServer(string pipeName, RequestHandler handler, ILogger<PipeServer> log)
{
    public async Task RunAsync(CancellationToken ct)
    {
        log.LogInformation("listening on \\\\.\\pipe\\{Pipe}", pipeName);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var server = NamedPipeServerStreamAcl.Create(
                    pipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, Pipe.ServerSecurity());

                await server.WaitForConnectionAsync(ct);
                _ = ServeAsync(server, ct); // one client must never block the next
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "accept failed");
                await Task.Delay(500, ct);
            }
        }
    }

    private async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        try
        {
            using var reader = new StreamReader(pipe, leaveOpen: true);
            await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };

            var line = await reader.ReadLineAsync(ct);
            if (line is null) return;

            Response response;
            try
            {
                var request = JsonSerializer.Deserialize<Request>(line, Protocol.Json)
                              ?? throw new InvalidOperationException("empty request");
                response = await handler.HandleAsync(request, ct);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "bad request");
                response = Response.Failure("?", ex.Message, "bad-request");
            }

            await writer.WriteLineAsync(JsonSerializer.Serialize(response, Protocol.Json));
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            // Client hung up. Normal.
        }
        finally
        {
            await pipe.DisposeAsync();
        }
    }
}
