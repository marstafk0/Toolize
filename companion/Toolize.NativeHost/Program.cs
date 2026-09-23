using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
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
var client = new PipeClient(Protocol.PipeName(dev));
var stdin = Console.OpenStandardInput();
var stdout = Console.OpenStandardOutput();

while (true)
{
    var message = await ReadMessageAsync(stdin);
    if (message is null) return 0; // browser closed the port

    Response response;
    try
    {
        var request = JsonSerializer.Deserialize<Request>(message, Protocol.Json)
                      ?? throw new InvalidOperationException("unreadable message");
        response = await client.SendAsync(request);
    }
    catch (TimeoutException)
    {
        // The service isn't running. Say so plainly: the extension decides what to do,
        // and in this phase it carries on with its cached settings.
        response = Response.Failure("?", "the Toolize service isn't running", "no-service");
    }
    catch (Exception ex)
    {
        response = Response.Failure("?", ex.Message);
    }

    await WriteMessageAsync(stdout, JsonSerializer.Serialize(response, Protocol.Json));
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
