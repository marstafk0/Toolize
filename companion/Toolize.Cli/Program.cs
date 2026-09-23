using System.Text.Json;
using Toolize.Core;

// Toolize CLI — a thin client over the service's named pipe. Same authority as the GUI:
// none. The service decides what is allowed.
//
//   toolize status|settings|set <key> <value>|check-update|update|doctor|notes
//   --dev   talk to a dev service started with `--console`

var dev = args.Contains("--dev");
var rest = args.Where(a => a != "--dev").ToArray();
var client = new PipeClient(Protocol.PipeName(dev));
var verb = rest.FirstOrDefault() ?? "status";

try
{
    switch (verb)
    {
        case "status":
            await ShowStatusAsync();
            break;

        case "settings":
            Print((await Ask(Verbs.GetSettings)).Data);
            break;

        case "set":
            await SetAsync(rest.Skip(1).ToArray());
            break;

        case "check-update":
        {
            var info = (await Ask(Verbs.CheckUpdate)).DataAs<UpdateInfo>();
            Console.WriteLine(info is null ? "no answer"
                : info.Available ? $"update available: {info.Version}\n{info.Notes}"
                : $"up to date ({info.Version}){(info.Notes is null ? "" : $" — {info.Notes}")}");
            break;
        }

        case "update":
        {
            var response = await Ask(Verbs.ApplyUpdate);
            Console.WriteLine(response.Ok ? "installing — the service will restart itself" : $"failed: {response.Error}");
            return response.Ok ? 0 : 1;
        }

        case "doctor":
        {
            var checks = (await Ask(Verbs.Doctor)).DataAs<List<Check>>() ?? [];
            foreach (var c in checks)
            {
                Console.WriteLine($"{(c.Ok ? "ok  " : "FAIL")}  {c.Name,-24} {c.Detail}");
                if (!c.Ok && c.Fix is not null) Console.WriteLine($"        fix: {c.Fix}");
            }
            return checks.All(c => c.Ok) ? 0 : 1;
        }

        case "notes":
            foreach (var note in (await Ask(Verbs.Status)).DataAs<StatusReport>()?.Notes ?? []) Console.WriteLine(note);
            break;

        default:
            Console.Error.WriteLine($"unknown command '{verb}'. Try: status, settings, set, check-update, update, doctor, notes");
            return 2;
    }
    return 0;
}
catch (TimeoutException)
{
    Console.Error.WriteLine($"the Toolize service isn't running (pipe {Protocol.PipeName(dev)}).");
    return 3;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

async Task<Response> Ask(string v, object? a = null)
{
    var response = await client.SendAsync(v, a);
    if (!response.Ok) throw new InvalidOperationException(response.Error ?? "request failed");
    return response;
}

async Task ShowStatusAsync()
{
    var s = (await Ask(Verbs.Status)).DataAs<StatusReport>()!;
    Console.WriteLine($"Toolize {s.Version} ({s.Channel} channel)");
    Console.WriteLine($"  protection   {(s.Settings.Enabled ? "on" : "OFF")}, {s.Settings.Preset.ToString().ToLower()}, " +
                      $"{(s.Settings.Mode == RevealMode.Safe ? "safe reveal" : "detect then blur")}" +
                      $"{(s.Settings.BlockAdultSites ? ", adult sites blocked" : "")}");
    Console.WriteLine($"  lock         {(s.Lock.Enrolled ? s.Lock.KeyPresent ? "unlocked (key present)" : "LOCKED" : "no key enrolled")}");
    Console.WriteLine($"  extension    {(s.Extension.Connected ? $"connected ({s.Extension.Version}), {s.Extension.Blocked} blocked / {s.Extension.Checked} checked" : "not connected")}");
    if (s.Update is { Available: true }) Console.WriteLine($"  update       {s.Update.Version} available — run `toolize update`");
}

async Task SetAsync(string[] pair)
{
    if (pair.Length != 2)
    {
        Console.Error.WriteLine("usage: toolize set <enabled|preset|mode|blockAdultSites> <value>");
        return;
    }
    var current = (await Ask(Verbs.GetSettings)).DataAs<Settings>()!;
    var (key, value) = (pair[0].ToLowerInvariant(), pair[1].ToLowerInvariant());
    var next = key switch
    {
        "enabled" => current with { Enabled = ParseBool(value) },
        "preset" => current with { Preset = Enum.Parse<Preset>(value, true) },
        "mode" => current with { Mode = Enum.Parse<RevealMode>(value, true) },
        "blockadultsites" => current with { BlockAdultSites = ParseBool(value) },
        _ => throw new ArgumentException($"unknown setting '{pair[0]}'"),
    };

    var response = await client.SendAsync(Verbs.SetSettings, new SetSettingsArgs(next));
    if (response is { Ok: false, Code: "locked" })
    {
        Console.Error.WriteLine(response.Error);
        Environment.Exit(4);
    }
    if (!response.Ok) throw new InvalidOperationException(response.Error);
    Print(response.Data);
}

static bool ParseBool(string v) => v is "on" or "true" or "yes" or "1";

static void Print(JsonElement? data) =>
    Console.WriteLine(data is null ? "(no data)" : JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
