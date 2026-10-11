using System.Reflection;
using System.Text.Json;

namespace Toolize.Core;

public sealed record FeedToggleInfo(string Key, string Label, string Hint);

public sealed record FeedSiteInfo(string Id, string Name, IReadOnlyList<FeedToggleInfo> Toggles);

/// <summary>
/// The extension's feed toggles (extension/sites/*.json, embedded at build time), so the
/// app and CLI offer exactly what the extension can do without a copy to keep in step.
/// </summary>
public static class FeedCatalog
{
    private static readonly string[] Order = ["youtube", "facebook"];

    public static IReadOnlyList<FeedSiteInfo> Sites { get; } = Load();

    /// <summary>"youtube.home" → "the YouTube home feed".</summary>
    public static string Describe(string key)
    {
        foreach (var site in Sites)
            foreach (var t in site.Toggles)
                if (t.Key == key) return $"the {site.Name} {t.Label.ToLowerInvariant()}";
        return key;
    }

    public static bool IsKnown(string key) => Sites.Any(s => s.Toggles.Any(t => t.Key == key));

    private static IReadOnlyList<FeedSiteInfo> Load()
    {
        var asm = typeof(FeedCatalog).Assembly;
        var sites = new List<FeedSiteInfo>();
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith("sites.") && n.EndsWith(".json")))
        {
            using var stream = asm.GetManifestResourceStream(name)!;
            using var doc = JsonDocument.Parse(stream);
            var root = doc.RootElement;
            var id = root.GetProperty("id").GetString()!;
            var toggles = root.GetProperty("toggles").EnumerateArray()
                .Select(t => new FeedToggleInfo(
                    $"{id}.{t.GetProperty("id").GetString()}",
                    t.GetProperty("label").GetString()!,
                    t.GetProperty("hint").GetString()!))
                .ToList();
            sites.Add(new FeedSiteInfo(id, root.GetProperty("name").GetString()!, toggles));
        }
        return sites
            .OrderBy(s => Array.IndexOf(Order, s.Id) is var i && i < 0 ? int.MaxValue : i)
            .ThenBy(s => s.Id)
            .ToList();
    }
}
