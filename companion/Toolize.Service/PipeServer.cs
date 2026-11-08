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
    public const int MaxLineLength = 256 * 1024;
    public const int MaxConcurrentHandlers = 64;
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(10);

    private readonly SemaphoreSlim _slots = new(MaxConcurrentHandlers, MaxConcurrentHandlers);

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
        var acquired = false;
        try
        {
            await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };

            acquired = await _slots.WaitAsync(0, ct);
            if (!acquired)
            {
                var busy = Response.Failure("?", "too many concurrent requests", "busy");
                await writer.WriteLineAsync(JsonSerializer.Serialize(busy, Protocol.Json));
                return;
            }

            using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            readCts.CancelAfter(ReadTimeout);

            string? line;
            try
            {
                line = await ReadBoundedLineAsync(pipe, MaxLineLength, readCts.Token);
            }
            catch (InvalidDataException ex)
            {
                var tooLong = Response.Failure("?", ex.Message, "bad-request");
                await writer.WriteLineAsync(JsonSerializer.Serialize(tooLong, Protocol.Json));
                return;
            }
            if (line is null) return;

            Response response;
            Request? request = null;
            try
            {
                request = JsonSerializer.Deserialize<Request>(line, Protocol.Json)
                          ?? throw new InvalidOperationException("empty request");
                // The read timeout covers only the request line: handling may legitimately
                // take longer (watch-settings holds ~25 s, apply-update downloads a file).
                response = await handler.HandleAsync(request, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                log.LogWarning(ex, "bad request");
                response = Response.Failure(request?.Id ?? "?", ex.Message, "bad-request");
            }

            await writer.WriteLineAsync(JsonSerializer.Serialize(response, Protocol.Json));
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException)
        {
            // Client hung up or read timed out. Normal.
        }
        finally
        {
            if (acquired) _slots.Release();
            await pipe.DisposeAsync();
        }
    }

    public static async Task<string?> ReadBoundedLineAsync(Stream stream, int maxBytes, CancellationToken ct)
    {
        var bytes = new List<byte>(256);
        var buf = new byte[1];
        var any = false;
        while (true)
        {
            var n = await stream.ReadAsync(buf.AsMemory(0, 1), ct);
            if (n == 0) return any ? System.Text.Encoding.UTF8.GetString(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(bytes)) : null;
            any = true;
            var b = buf[0];
            if (b == (byte)'\n')
            {
                if (bytes.Count > 0 && bytes[^1] == (byte)'\r') bytes.RemoveAt(bytes.Count - 1);
                return System.Text.Encoding.UTF8.GetString(System.Runtime.InteropServices.CollectionsMarshal.AsSpan(bytes));
            }
            if (bytes.Count >= maxBytes)
                throw new InvalidDataException($"request line exceeds {maxBytes} bytes");
            bytes.Add(b);
        }
    }
}
