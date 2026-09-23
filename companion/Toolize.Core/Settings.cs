namespace Toolize.Core;

public enum Preset { Strict, Balanced, Relaxed }

public enum RevealMode { Safe, Fast }

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
        || (before.BlockAdultSites && !after.BlockAdultSites);

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
        return list;
    }
}
