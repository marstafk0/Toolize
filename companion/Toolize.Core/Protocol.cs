using System.Text.Json;
using System.Text.Json.Serialization;

namespace Toolize.Core;

/// <summary>
/// Wire protocol between the service and its clients (GUI, CLI, browser extension via
/// the native messaging host): newline-delimited JSON over a named pipe, one request
/// and one response per line.
///
/// Clients hold no authority. Every decision — above all, whether a change is allowed
/// while locked — is made by the service.
/// </summary>
public static class Protocol
{
    /// <summary>Pipe name. The dev build uses a separate pipe so it never fights the installed service.</summary>
    public static string PipeName(bool dev = false) => dev ? "toolize-dev" : "toolize";

    /// <summary>
    /// camelCase names and lower-case enum *names* (not numbers): the extension shares
    /// these settings verbatim, and "strict" has to mean the same thing on both sides.
    /// </summary>
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}

public sealed record Request(string Verb)
{
    public string Id { get; init; } = Guid.NewGuid().ToString("n")[..8];
    public JsonElement? Args { get; init; }

    public T? ArgsAs<T>() => Args is null ? default : Args.Value.Deserialize<T>(Protocol.Json);
}

public sealed record Response
{
    public required string Id { get; init; }
    public required bool Ok { get; init; }
    public JsonElement? Data { get; init; }
    public string? Error { get; init; }
    /// <summary>Machine-readable reason, e.g. "locked" or "unknown-verb".</summary>
    public string? Code { get; init; }

    public static Response Success(string id, object? data = null) => new()
    {
        Id = id,
        Ok = true,
        Data = data is null ? null : JsonSerializer.SerializeToElement(data, Protocol.Json),
    };

    public static Response Failure(string id, string error, string code = "error") =>
        new() { Id = id, Ok = false, Error = error, Code = code };

    public T? DataAs<T>() => Data is null ? default : Data.Value.Deserialize<T>(Protocol.Json);
}

/// <summary>Verbs the service understands. Weakening verbs are gated on key presence.</summary>
public static class Verbs
{
    public const string Status = "status";
    public const string GetSettings = "get-settings";
    public const string SetSettings = "set-settings";
    public const string CheckUpdate = "check-update";
    public const string ApplyUpdate = "apply-update";
    public const string Doctor = "doctor";
    /// <summary>Extension handshake: reports its version, receives the settings of record.</summary>
    public const string ExtensionHello = "extension-hello";
    /// <summary>Extension liveness ping plus per-tab counters.</summary>
    public const string ExtensionHeartbeat = "extension-heartbeat";
}
