using System.Text.Json;
using System.Text.Json.Nodes;

namespace Toolize.Core;

public enum Preset { Strict, Balanced, Relaxed }

public enum RevealMode { Safe, Fast }

/// <summary>Where YouTube comments show. Ordered weakest to strongest.</summary>
public enum CommentMode { Show, Learning, Hide }

/// <summary>
/// The settings of record. The extension keeps a cache of these in chrome.storage, but
/// this copy is the authority — the extension asks, the service decides.
/// </summary>
public sealed record Settings
{
    public bool Enabled { get; init; } = true;
    public Preset Preset { get; init; } = Preset.Balanced;
    public RevealMode Mode { get; init; } = RevealMode.Safe;
    public bool BlockAdultSites { get; init; } = true;
    /// <summary>
    /// Leave live streams on YouTube, Twitch, Kick and Rumble alone: not sampled, not
    /// blurred, not paused. Off by default; turning it on needs the key.
    /// </summary>
    public bool AllowLiveStreams { get; init; }

    // ---- feed control (phase 6)

    /// <summary>
    /// Feed toggles that are on, keyed "&lt;site&gt;.&lt;toggle&gt;" as in the extension's
    /// sites/*.json (see <see cref="FeedCatalog"/>). Absent means off.
    /// </summary>
    public Dictionary<string, bool> Feeds { get; init; } = new();
    /// <summary>
    /// Show YouTube comments everywhere, only on how-to/learning videos, or nowhere.
    /// Commenter avatars and profile links are off and spam bots hidden in every mode.
    /// </summary>
    public CommentMode YoutubeComments { get; init; } = CommentMode.Show;

    // ---- enforcement (phase 5). Off by default: enforcement changes the browser for
    // every profile on the machine, so it is something the user turns on deliberately.

    /// <summary>Write browser policy so the extension can't simply be removed.</summary>
    public bool Enforce { get; init; }
    /// <summary>Private windows and fresh profiles are unfiltered browsers, so close them off.</summary>
    public bool BlockIncognito { get; init; } = true;
    /// <summary>Block other extensions, which could otherwise undo the filtering.</summary>
    public bool BlockOtherExtensions { get; init; }
    /// <summary>
    /// Turn off developer tools. With them, anything in a page — the blur, the fail-closed
    /// overlay — is one Delete key away. Also disables loading unpacked extensions.
    /// </summary>
    public bool BlockDevTools { get; init; } = true;
    /// <summary>What to do about a browser running without the extension reporting in.</summary>
    public Watchdog Watchdog { get; init; } = Watchdog.Warn;

    public static Settings Default => new();
}

/// <summary>
/// Which direction a settings change moves protection. Strengthening is always allowed;
/// weakening requires a verified key once one is enrolled (phase 4).
///
/// Anything unrecognised counts as weakening — new settings must opt in to being safe,
/// so a future field can't quietly become a bypass.
/// </summary>
public static class SettingsPolicy
{
    public static bool IsWeakening(Settings before, Settings after) =>
        (before.Enabled && !after.Enabled)
        || Strength(after.Preset) < Strength(before.Preset)
        || (before.Mode == RevealMode.Safe && after.Mode == RevealMode.Fast)
        || (before.BlockAdultSites && !after.BlockAdultSites)
        || (!before.AllowLiveStreams && after.AllowLiveStreams)
        || FeedsTurnedOff(before, after).Any()
        || after.YoutubeComments < before.YoutubeComments
        || (before.Enforce && !after.Enforce)
        || (before.BlockIncognito && !after.BlockIncognito)
        || (before.BlockOtherExtensions && !after.BlockOtherExtensions)
        || (before.BlockDevTools && !after.BlockDevTools)
        || after.Watchdog < before.Watchdog;

    /// <summary>Feed toggles on before and not on after (a missing key is off).</summary>
    private static IEnumerable<string> FeedsTurnedOff(Settings before, Settings after) =>
        (before.Feeds ?? []).Where(f => f.Value && !(after.Feeds ?? []).GetValueOrDefault(f.Key)).Select(f => f.Key);

    private static int Strength(Preset p) => p switch
    {
        Preset.Strict => 3,
        Preset.Balanced => 2,
        Preset.Relaxed => 1,
        _ => 0,
    };

    /// <summary>Human-readable list of what a change would weaken, for logs and prompts.</summary>
    public static IReadOnlyList<string> Weakenings(Settings before, Settings after)
    {
        var list = new List<string>();
        if (before.Enabled && !after.Enabled) list.Add("turning protection off");
        if (Strength(after.Preset) < Strength(before.Preset)) list.Add($"lowering sensitivity to {after.Preset}");
        if (before.Mode == RevealMode.Safe && after.Mode == RevealMode.Fast) list.Add("switching to detect-then-blur");
        if (before.BlockAdultSites && !after.BlockAdultSites) list.Add("turning off adult-site blocking");
        if (!before.AllowLiveStreams && after.AllowLiveStreams) list.Add("allowing live streams unfiltered");
        foreach (var key in FeedsTurnedOff(before, after)) list.Add($"showing {FeedCatalog.Describe(key)} again");
        if (after.YoutubeComments < before.YoutubeComments) list.Add($"showing more YouTube comments ({after.YoutubeComments})");
        if (before.Enforce && !after.Enforce) list.Add("turning off enforcement");
        if (before.BlockIncognito && !after.BlockIncognito) list.Add("re-allowing private windows");
        if (before.BlockOtherExtensions && !after.BlockOtherExtensions) list.Add("re-allowing other extensions");
        if (before.BlockDevTools && !after.BlockDevTools) list.Add("re-allowing developer tools");
        if (after.Watchdog < before.Watchdog) list.Add($"lowering the watchdog to {after.Watchdog}");
        return list;
    }

    /// <summary>
    /// Applies a client's settings on top of the current ones, field by field.
    ///
    /// Clients don't all know every setting — the extension has never heard of
    /// enforcement. Deserialising what they send as a whole record would fill the gaps
    /// with defaults, so an extension popup toggling the preset would also "turn off"
    /// enforcement. Only the fields actually present change.
    /// </summary>
    public static Settings Overlay(Settings current, JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object) throw new ArgumentException("settings must be an object");
        var node = JsonSerializer.SerializeToNode(current, Protocol.Json)!.AsObject();
        foreach (var property in patch.EnumerateObject())
        {
            // Match on the serialised name, case-insensitively, and ignore anything
            // unknown rather than letting it through to the record.
            var known = node.Select(p => p.Key)
                .FirstOrDefault(k => string.Equals(k, property.Name, StringComparison.OrdinalIgnoreCase));
            if (known is null) continue;
            var value = JsonNode.Parse(property.Value.GetRawText());
            // Maps (feeds) merge key by key too: leaving a key out doesn't turn it off.
            if (node[known] is JsonObject existing && value is JsonObject incoming)
                foreach (var (k, v) in incoming.ToList())
                {
                    incoming.Remove(k);
                    existing[k] = v;
                }
            else node[known] = value;
        }
        return node.Deserialize<Settings>(Protocol.Json)!;
    }
}
