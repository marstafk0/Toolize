using System.Text.Json;
using Toolize.Core;
using Xunit;

namespace Toolize.Tests;

/// <summary>
/// What enforcement writes into the browser. These values change every profile on the
/// machine, so the rules are pinned down here rather than discovered on a live PC.
/// </summary>
public sealed class PolicyPlanTests
{
    private const string Id = "mckophjbolaofjkhebkcelhnmjofeajf";
    private static readonly Settings Enforcing = Settings.Default with { Enforce = true };
    private static readonly string[] AllBrowsers = ["Chrome", "Edge", "Brave"];

    private static IReadOnlyList<PolicyValue> Plan(Settings s, string browser = "Chrome") =>
        PolicyPlan.For(s, Id, browser);

    [Fact]
    public void Nothing_is_written_unless_enforcement_is_on() =>
        Assert.Empty(Plan(Settings.Default));

    [Fact]
    public void Enforcing_force_installs_the_store_extension()
    {
        var forcelist = Assert.Single(Plan(Enforcing).Where(v => v.SubKey == "ExtensionInstallForcelist"));
        Assert.Equal($"{Id};{PolicyPlan.StoreUpdateUrl}", forcelist.Value);
    }

    [Fact]
    public void Our_extension_settings_entry_says_force_installed_too()
    {
        // ExtensionSettings beats the forcelist for an id it names, and older installers
        // named ours normal_installed. Left alone, that would make the forcelist moot.
        var mode = Assert.Single(Plan(Enforcing).Where(v => v.SubKey == $@"ExtensionSettings\{Id}" && v.Name == "installation_mode"));
        Assert.Equal("force_installed", mode.Value);
    }

    [Fact]
    public void Turning_enforcement_off_leaves_nothing_that_blocks_removal()
    {
        // normal_installed also hides Remove, so releasing must delete, never revert to it.
        Assert.All(PolicyPlan.AllOwned(Id), v => Assert.Null(v.Released));
    }

    [Fact]
    public void Extension_settings_are_never_written_as_a_json_string()
    {
        // The installer uses the subkey form; mixing in the JSON value leaves Chrome to
        // pick one. Every combination must stay with subkeys.
        var settings = Enforcing with { BlockOtherExtensions = true };
        foreach (var browser in AllBrowsers)
            Assert.DoesNotContain(Plan(settings, browser), v => v.SubKey == "" && v.Name == "ExtensionSettings");
    }

    [Fact]
    public void Edge_uses_its_own_name_for_private_browsing()
    {
        var chrome = Plan(Enforcing, "Chrome").Select(v => v.Name);
        var edge = Plan(Enforcing, "Edge").Select(v => v.Name);
        Assert.Contains("IncognitoModeAvailability", chrome);
        Assert.Contains("InPrivateModeAvailability", edge);
        Assert.DoesNotContain("IncognitoModeAvailability", edge);
    }

    [Fact]
    public void Brave_tor_windows_go_with_private_windows()
    {
        Assert.Contains(Plan(Enforcing, "Brave"), v => v.Name == "TorDisabled" && (int)v.Value == 1);
        Assert.DoesNotContain(Plan(Enforcing, "Chrome"), v => v.Name == "TorDisabled");
        Assert.DoesNotContain(Plan(Enforcing with { BlockIncognito = false }, "Brave"), v => v.Name == "TorDisabled");
    }

    [Fact]
    public void Guest_and_new_profiles_are_closed_off_with_incognito()
    {
        // A fresh profile is an unfiltered browser, so these travel together.
        var names = Plan(Enforcing).Select(v => v.Name).ToList();
        Assert.Contains("BrowserGuestModeEnabled", names);
        Assert.Contains("BrowserAddPersonEnabled", names);

        var relaxed = Plan(Enforcing with { BlockIncognito = false }).Select(v => v.Name);
        Assert.DoesNotContain("BrowserGuestModeEnabled", relaxed);
    }

    [Fact]
    public void Developer_tools_are_off_by_default_when_enforcing()
    {
        Assert.Contains(Plan(Enforcing), v => v.Name == "DeveloperToolsAvailability" && (int)v.Value == 2);
        Assert.DoesNotContain(Plan(Enforcing with { BlockDevTools = false }), v => v.Name == "DeveloperToolsAvailability");
    }

    [Fact]
    public void Blocking_other_extensions_is_opt_in_and_still_allows_ours()
    {
        Assert.DoesNotContain(Plan(Enforcing), v => v.SubKey == @"ExtensionSettings\*");

        var plan = Plan(Enforcing with { BlockOtherExtensions = true });
        var all = Assert.Single(plan.Where(v => v.SubKey == @"ExtensionSettings\*"));
        Assert.Equal(("installation_mode", "blocked"), (all.Name, (string)all.Value));
        Assert.Contains(plan, v => v.SubKey == $@"ExtensionSettings\{Id}" && (string)v.Value == "force_installed");
    }

    [Fact]
    public void Everything_we_write_is_also_something_we_can_remove()
    {
        // Turning enforcement off has to restore the browser completely, so every value
        // any settings combination can produce must appear in the owned list.
        var owned = PolicyPlan.AllOwned(Id).Select(v => (v.SubKey, v.Name)).ToHashSet();
        foreach (var browser in AllBrowsers)
        foreach (var incognito in new[] { true, false })
        foreach (var others in new[] { true, false })
        foreach (var devtools in new[] { true, false })
        {
            var settings = Enforcing with { BlockIncognito = incognito, BlockOtherExtensions = others, BlockDevTools = devtools };
            foreach (var value in Plan(settings, browser))
                Assert.Contains((value.SubKey, value.Name), owned);
        }
    }

    [Fact]
    public void The_old_json_extension_settings_value_is_cleaned_up() =>
        // 0.5.x dev builds wrote it; owning it means the first reconcile deletes it.
        Assert.Contains(PolicyPlan.AllOwned(Id), v => v.SubKey == "" && v.Name == "ExtensionSettings" && v.Released is null);

    [Fact]
    public void All_three_chromium_browsers_are_covered()
    {
        var roots = PolicyPlan.Browsers.Select(b => b.Root).ToList();
        Assert.Contains(@"SOFTWARE\Policies\Google\Chrome", roots);
        Assert.Contains(@"SOFTWARE\Policies\Microsoft\Edge", roots);
        Assert.Contains(@"SOFTWARE\Policies\BraveSoftware\Brave", roots);
    }
}

public sealed class EnforcementWeakeningTests
{
    private static readonly Settings On = Settings.Default with { Enforce = true, BlockOtherExtensions = true };

    [Fact]
    public void Turning_enforcement_off_needs_the_key() =>
        Assert.True(SettingsPolicy.IsWeakening(On, On with { Enforce = false }));

    [Fact]
    public void Turning_enforcement_on_does_not() =>
        Assert.False(SettingsPolicy.IsWeakening(Settings.Default, Settings.Default with { Enforce = true }));

    [Fact]
    public void Re_allowing_private_windows_or_other_extensions_is_weakening()
    {
        Assert.True(SettingsPolicy.IsWeakening(On, On with { BlockIncognito = false }));
        Assert.True(SettingsPolicy.IsWeakening(On, On with { BlockOtherExtensions = false }));
        Assert.True(SettingsPolicy.IsWeakening(On, On with { BlockDevTools = false }));
    }

    [Fact]
    public void Allowing_live_streams_needs_the_key_and_filtering_them_again_does_not()
    {
        Assert.True(SettingsPolicy.IsWeakening(On, On with { AllowLiveStreams = true }));
        Assert.False(SettingsPolicy.IsWeakening(On with { AllowLiveStreams = true }, On));
    }

    [Theory]
    [InlineData(Watchdog.Close, Watchdog.Warn, true)]
    [InlineData(Watchdog.Warn, Watchdog.Off, true)]
    [InlineData(Watchdog.Off, Watchdog.Close, false)]
    public void Lowering_the_watchdog_is_weakening(Watchdog from, Watchdog to, bool weakening) =>
        Assert.Equal(weakening, SettingsPolicy.IsWeakening(On with { Watchdog = from }, On with { Watchdog = to }));
}

/// <summary>
/// Clients send settings they know about. Those they don't must keep their value — the
/// extension popup has never heard of enforcement and must not switch it off.
/// </summary>
public sealed class SettingsOverlayTests
{
    private static readonly Settings Locked = Settings.Default with
    {
        Enforce = true, BlockOtherExtensions = true, Watchdog = Watchdog.Close, Preset = Preset.Strict,
    };

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    [Fact]
    public void Fields_the_client_leaves_out_keep_their_value()
    {
        // Exactly what the extension sends: its four fields and nothing else.
        var after = SettingsPolicy.Overlay(Locked,
            Json("""{"enabled":true,"preset":"balanced","mode":"safe","blockAdultSites":true}"""));
        Assert.Equal(Preset.Balanced, after.Preset);
        Assert.True(after.Enforce);
        Assert.True(after.BlockOtherExtensions);
        Assert.Equal(Watchdog.Close, after.Watchdog);
    }

    [Fact]
    public void A_partial_change_is_judged_only_on_what_changed()
    {
        var after = SettingsPolicy.Overlay(Locked, Json("""{"preset":"strict"}"""));
        Assert.False(SettingsPolicy.IsWeakening(Locked, after));
    }

    [Fact]
    public void Fields_that_are_sent_do_change() =>
        Assert.False(SettingsPolicy.Overlay(Locked, Json("""{"enforce":false}""")).Enforce);

    [Fact]
    public void Unknown_fields_are_ignored() =>
        Assert.Equal(Serialize(Locked), Serialize(SettingsPolicy.Overlay(Locked, Json("""{"somethingNew":1}"""))));

    [Fact]
    public void Feed_toggles_merge_key_by_key()
    {
        var before = Locked with { Feeds = new() { ["youtube.home"] = true, ["youtube.shorts"] = true } };
        var after = SettingsPolicy.Overlay(before, Json("""{"feeds":{"facebook.feed":true}}"""));
        Assert.True(after.Feeds["youtube.home"]); // left out, so untouched
        Assert.True(after.Feeds["facebook.feed"]);
        Assert.False(SettingsPolicy.IsWeakening(before, after));

        var off = SettingsPolicy.Overlay(before, Json("""{"feeds":{"youtube.home":false}}"""));
        Assert.True(SettingsPolicy.IsWeakening(before, off));
    }

    private static string Serialize(Settings s) => JsonSerializer.Serialize(s, Protocol.Json);
}

public sealed class FeedSettingsTests
{
    private static readonly Settings Hiding = Settings.Default with
    {
        Feeds = new() { ["youtube.home"] = true },
    };

    [Fact]
    public void Hiding_more_never_needs_the_key()
    {
        Assert.False(SettingsPolicy.IsWeakening(Settings.Default, Hiding));
        Assert.False(SettingsPolicy.IsWeakening(Hiding, Hiding with { Feeds = new() { ["youtube.home"] = true, ["facebook.feed"] = true } }));
    }

    [Fact]
    public void Showing_a_feed_again_needs_the_key()
    {
        Assert.True(SettingsPolicy.IsWeakening(Hiding, Hiding with { Feeds = new() { ["youtube.home"] = false } }));
        Assert.True(SettingsPolicy.IsWeakening(Hiding, Hiding with { Feeds = new() })); // dropping the key = off
        Assert.Contains("showing the YouTube home feed again", SettingsPolicy.Weakenings(Hiding, Hiding with { Feeds = new() }));
    }

    [Fact]
    public void Settings_saved_before_feeds_existed_still_load()
    {
        var old = JsonSerializer.Deserialize<Settings>("""{"enabled":true,"preset":"strict"}""", Protocol.Json)!;
        Assert.Empty(old.Feeds);
        // 0.7.0 saved a comment mode that no longer exists; it must not break loading.
        var v070 = JsonSerializer.Deserialize<Settings>("""{"enabled":true,"youtubeComments":"learning"}""", Protocol.Json)!;
        Assert.True(v070.Enabled);
    }

    [Fact]
    public void The_catalog_is_the_extension_one()
    {
        var keys = FeedCatalog.Sites.SelectMany(s => s.Toggles).Select(t => t.Key).ToList();
        Assert.Equal("youtube", FeedCatalog.Sites[0].Id);
        Assert.Contains("youtube.home", keys);
        Assert.Contains("youtube.shorts", keys);
        Assert.Contains("youtube.comments", keys);
        Assert.Contains("facebook.feed", keys);
    }

    [Fact]
    public void The_wire_names_match_the_extension()
    {
        var json = JsonSerializer.Serialize(Hiding, Protocol.Json);
        Assert.Contains("\"feeds\":{\"youtube.home\":true}", json);
    }
}
