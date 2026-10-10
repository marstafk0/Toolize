using System.Text.Json;
using Toolize.Core;

// Toolize CLI — a thin client over the service's named pipe. Same authority as the GUI:
// none. The service decides what is allowed.
//
//   toolize status|settings|set <key> <value>|channel <name>
//   toolize drives|enroll-key <drive> [name]|keys|revoke-key <id>|recover <code>
//   toolize check-update|update|doctor|notes
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

        case "channel":
        {
            var name = rest.Skip(1).FirstOrDefault();
            if (name is null) { Console.WriteLine((await Ask(Verbs.Status)).DataAs<StatusReport>()?.Channel); break; }
            var info = (await Ask(Verbs.SetChannel, new SetChannelArgs(name))).DataAs<UpdateInfo>();
            Console.WriteLine($"channel set to {name}" + (info?.Available == true ? $" — {info.Version} available" : ""));
            break;
        }

        case "drives":
        {
            var drives = (await Ask(Verbs.Drives)).DataAs<List<DriveOption>>() ?? [];
            if (drives.Count == 0) { Console.WriteLine("no removable drives are plugged in"); break; }
            foreach (var d in drives)
                Console.WriteLine($"  {d.Letter,-4} {d.Label,-20} {d.Bytes / 1_000_000_000.0:F1} GB{(d.HasKey ? "  [has a Toolize key]" : "")}");
            break;
        }

        case "enroll-key":
        {
            var drive = rest.Skip(1).FirstOrDefault();
            if (drive is null) { Console.Error.WriteLine("usage: toolize enroll-key <drive letter> [name]"); return 2; }
            var name = string.Join(' ', rest.Skip(2)).Trim();
            var response = await client.SendAsync(Verbs.EnrollKey, new EnrollKeyArgs(drive, name));
            if (!response.Ok) { Console.Error.WriteLine(response.Error); return 4; }
            var enrolled = response.Data!.Value;
            Console.WriteLine($"enrolled {drive} as \"{enrolled.GetProperty("key").GetProperty("name").GetString()}\"");
            if (enrolled.TryGetProperty("recovery", out var code) && code.ValueKind == JsonValueKind.String)
            {
                Console.WriteLine();
                Console.WriteLine("  RECOVERY CODE (shown once — write it down and give it to your partner):");
                Console.WriteLine($"      {code.GetString()}");
                Console.WriteLine("  Without it, losing every key means reinstalling from scratch.");
            }
            break;
        }

        case "keys":
        {
            var s2 = (await Ask(Verbs.Status)).DataAs<StatusReport>()!;
            if (s2.Keys.Count == 0) { Console.WriteLine("no keys enrolled"); break; }
            foreach (var k in s2.Keys)
                Console.WriteLine($"  {k.Id}  {k.Name,-20} {k.Tier,-6} enrolled {k.EnrolledAt.LocalDateTime:yyyy-MM-dd}" +
                                  $"{(k.LastSeen is { } seen ? $", last seen {seen.LocalDateTime:yyyy-MM-dd HH:mm}" : "")}");
            Console.WriteLine(s2.HasRecoveryCode ? "  recovery code: issued and unused" : "  recovery code: NONE");
            break;
        }

        case "revoke-key":
        {
            var id = rest.Skip(1).FirstOrDefault();
            if (id is null) { Console.Error.WriteLine("usage: toolize revoke-key <id>"); return 2; }
            var response = await client.SendAsync(Verbs.RevokeKey, new RevokeKeyArgs(id));
            Console.WriteLine(response.Ok ? $"revoked {id}" : response.Error);
            return response.Ok ? 0 : 4;
        }

        case "recover":
        {
            var code = rest.Skip(1).FirstOrDefault();
            if (code is null) { Console.Error.WriteLine("usage: toolize recover <code>"); return 2; }
            var response = await client.SendAsync(Verbs.Recover, new RecoverArgs(code));
            Console.WriteLine(response.Ok
                ? "recovered — all keys cleared, protection stays on. Enroll a new key now."
                : response.Error);
            return response.Ok ? 0 : 4;
        }

        // Used by the uninstaller. Exit 0 = go ahead, 4 = locked, 3 = service not running
        // (handled by the catch below, which also lets a broken install be removed).
        case "uninstall-check":
        {
            var s3 = (await Ask(Verbs.Status)).DataAs<StatusReport>()!;
            if (s3.Lock.CanWeaken) return 0;
            Console.Error.WriteLine("Plug in your Toolize key to uninstall.");
            return 4;
        }

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
            Console.Error.WriteLine($"unknown command '{verb}'. Try: status, settings, set, channel, drives, enroll-key, keys, revoke-key, recover, check-update, update, doctor, notes, uninstall-check");
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
    Console.WriteLine($"  extension    {(s.Extension.Connected ? $"connected ({s.Extension.Version}{(s.Extension.Browsers.Count > 0 ? $" in {string.Join(", ", s.Extension.Browsers)}" : "")}), {s.Extension.Blocked} blocked / {s.Extension.Checked} checked" : "not connected")}");
    Console.WriteLine($"  enforcement  {(s.Enforcement.Applied ? s.Enforcement.Summary : "off — the extension can still be removed in the browser")}");
    if (s.Enforcement.Applied) Console.WriteLine($"  watchdog     {s.Enforcement.Watchdog}");
    if (s.Update is { Available: true }) Console.WriteLine($"  update       {s.Update.Version} available — run `toolize update`");
}

async Task SetAsync(string[] pair)
{
    if (pair.Length != 2)
    {
        Console.Error.WriteLine("""
            usage: toolize set <setting> <value>
              enabled | blockAdultSites | enforce | blockIncognito | blockOtherExtensions | blockDevTools   on|off
              preset   strict|balanced|relaxed
              mode     safe|fast
              watchdog off|warn|close
            """);
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
        "enforce" => current with { Enforce = ParseBool(value) },
        "blockincognito" => current with { BlockIncognito = ParseBool(value) },
        "blockotherextensions" => current with { BlockOtherExtensions = ParseBool(value) },
        "blockdevtools" => current with { BlockDevTools = ParseBool(value) },
        "watchdog" => current with { Watchdog = Enum.Parse<Watchdog>(value, true) },
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
