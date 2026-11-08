using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Toolize.Core;

// Native messaging host: the bridge between the browser extension and the service.
//
// Chrome starts this process and talks to it over stdio in its own framing (a 32-bit
// little-endian length, then UTF-8 JSON). Everything it says is forwarded to the
// service's pipe, and the service's answer is sent back. This process holds no state and
// makes no decisions — it is a wire, nothing more.
//
// Chrome also kills it whenever the extension disconnects, so it must exit quietly on a
// closed stdin rather than treating that as an error.

var dev = args.Contains("--dev");
// Chrome passes the caller's origin ("chrome-extension://<id>/") as the first argument.
// It comes from the browser, not the extension, so it can't be faked by the extension
// and tells the service which build is reporting in: the store copy that enforcement
// pins in place, or an unpacked dev copy that anyone can remove.
var callerId = args.Select(a => a.StartsWith("chrome-extension://", StringComparison.Ordinal)
        ? a["chrome-extension://".Length..].TrimEnd('/')
        : null)
    .FirstOrDefault(id => !string.IsNullOrEmpty(id));
var client = new PipeClient(Protocol.PipeName(dev));
var stdin = Console.OpenStandardInput();
var stdout = Console.OpenStandardOutput();
var writeGate = new SemaphoreSlim(1, 1);
using var cts = new CancellationTokenSource();
var firstRevision = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
var lastRevision = 0;

var watchTask = WatchSettingsLoopAsync(client, stdout, writeGate, firstRevision.Task,
    () => Volatile.Read(ref lastRevision),
    rev => Interlocked.Exchange(ref lastRevision, rev),
    cts.Token);

try
{
    while (true)
    {
        var message = await ReadMessageAsync(stdin);
        if (message is null) break; // browser closed the port

        Request? request = null;
        Response response;
        try
        {
            request = JsonSerializer.Deserialize<Request>(message, Protocol.Json)
                      ?? throw new InvalidOperationException("unreadable message");
            response = await client.SendAsync(StampCaller(request, callerId), cts.Token, timeoutMs: 2000);
            if (TryGetRevision(response.Data, out var rev))
            {
                Interlocked.Exchange(ref lastRevision, rev);
                firstRevision.TrySetResult(rev);
            }
        }
        catch (TimeoutException)
        {
            // The service isn't running. Say so plainly: the extension decides what to do,
            // and in this phase it carries on with its cached settings.
            response = Response.Failure(request?.Id ?? "?", "the Toolize service isn't running", "no-service");
        }
        catch (Exception ex)
        {
            response = Response.Failure(request?.Id ?? "?", ex.Message);
        }

        await WriteProtectedAsync(stdout, writeGate, JsonSerializer.Serialize(response, Protocol.Json));
    }
}
finally
{
    cts.Cancel();
    try
    {
        await watchTask;
    }
    catch
    {
        // Exit quietly when stdin closes.
    }
}
return 0;

static async Task WatchSettingsLoopAsync(
    PipeClient client,
    Stream stdout,
    SemaphoreSlim writeGate,
    Task<int> initialRevisionTask,
    Func<int> getRevision,
    Action<int> setRevision,
    CancellationToken ct)
{
    // Wait briefly for the initial hello/heartbeat to learn the starting revision so we
    // don't send a redundant immediate push; if none arrives quickly, start at 0.
    try
    {
        using var initCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        initCts.CancelAfter(TimeSpan.FromSeconds(2));
        await initialRevisionTask.WaitAsync(initCts.Token);
    }
    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
    {
        // Carry on from revision 0.
    }

    int[] backoffs = [2000, 5000, 10000];
    var failures = 0;

    while (!ct.IsCancellationRequested)
    {
        try
        {
            var currentRev = getRevision();
            var req = new Request(Verbs.WatchSettings)
            {
                Args = JsonSerializer.SerializeToElement(new WatchSettingsArgs(currentRev), Protocol.Json),
            };
            var resp = await client.SendAsync(req, ct, timeoutMs: 2000, readTimeoutMs: 30000);
            if (!resp.Ok || resp.Data is not { } data)
            {
                var delay = backoffs[Math.Min(failures++, backoffs.Length - 1)];
                await Task.Delay(delay, ct);
                continue;
            }

            failures = 0;
            if (TryGetRevision(data, out var rev) && rev > getRevision())
            {
                setRevision(rev);
                if (data.TryGetProperty("settings", out var settings)
                    && data.TryGetProperty("enforced", out var enforced))
                {
                    var push = new
                    {
                        id = "push",
                        ok = true,
                        data = new
                        {
                            settings,
                            enforced = enforced.GetBoolean(),
                        },
                    };
                    await WriteProtectedAsync(stdout, writeGate, JsonSerializer.Serialize(push, Protocol.Json));
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            break;
        }
        catch
        {
            var delay = backoffs[Math.Min(failures++, backoffs.Length - 1)];
            await Task.Delay(delay, ct);
        }
    }
}

static bool TryGetRevision(JsonElement? data, out int revision)
{
    if (data is { ValueKind: JsonValueKind.Object } d
        && d.TryGetProperty("revision", out var prop)
        && prop.TryGetInt32(out revision))
        return true;
    revision = 0;
    return false;
}

static async Task WriteProtectedAsync(Stream output, SemaphoreSlim gate, string json)
{
    await gate.WaitAsync();
    try
    {
        await WriteMessageAsync(output, json);
    }
    finally
    {
        gate.Release();
    }
}

// Overwrites any extensionId the extension put in its args with the one Chrome reported.
static Request StampCaller(Request request, string? callerId)
{
    if (request.Verb is not (Verbs.ExtensionHello or Verbs.ExtensionHeartbeat)) return request;
    var args = request.Args is { ValueKind: JsonValueKind.Object } a
        ? JsonNode.Parse(a.GetRawText())!.AsObject()
        : new JsonObject();
    args["extensionId"] = callerId;
    return request with { Args = JsonSerializer.SerializeToElement(args) };
}

static async Task<string?> ReadMessageAsync(Stream input)
{
    var header = new byte[4];
    if (!await ReadExactlyAsync(input, header)) return null;
    var length = BinaryPrimitives.ReadInt32LittleEndian(header);
    if (length is <= 0 or > 64 * 1024 * 1024) return null;

    var payload = new byte[length];
    return await ReadExactlyAsync(input, payload) ? Encoding.UTF8.GetString(payload) : null;
}

static async Task<bool> ReadExactlyAsync(Stream input, byte[] buffer)
{
    var read = 0;
    while (read < buffer.Length)
    {
        var got = await input.ReadAsync(buffer.AsMemory(read));
        if (got == 0) return false;
        read += got;
    }
    return true;
}

static async Task WriteMessageAsync(Stream output, string json)
{
    var payload = Encoding.UTF8.GetBytes(json);
    var header = new byte[4];
    BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
    await output.WriteAsync(header);
    await output.WriteAsync(payload);
    await output.FlushAsync();
}
