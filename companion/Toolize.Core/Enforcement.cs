namespace Toolize.Core;

/// <summary>How hard the watchdog reacts when a managed browser runs unprotected.</summary>
public enum Watchdog
{
    /// <summary>Do nothing. Protection still applies inside the browser.</summary>
    Off,
    /// <summary>Show a window saying protection is missing, but leave the browser alone.</summary>
    Warn,
    /// <summary>Warn, then close the browser after a grace period.</summary>
    Close,
}

/// <summary>
/// One registry value the enforcement layer owns.
///
/// <paramref name="Released"/> is what the value goes back to when enforcement no longer
/// wants it; null deletes it. Everything enforcement writes is currently deleted.
/// </summary>
public sealed record PolicyValue(string SubKey, string Name, object Value, object? Released = null)
{
    public bool IsDword => Value is int;
}

/// <summary>
/// Turns settings into the exact browser policy the machine should have.
///
/// Kept pure and separate from the registry so the rules can be read, tested and
/// reasoned about without a machine in the loop: what we write is what we remove, and
/// nothing else on the system is touched.
/// </summary>
public static class PolicyPlan
{
    /// <summary>Chromium policy roots. All three read machine policy wherever they're installed.</summary>
    public static readonly (string Name, string Root)[] Browsers =
    [
        ("Chrome", @"SOFTWARE\Policies\Google\Chrome"),
        ("Edge", @"SOFTWARE\Policies\Microsoft\Edge"),
        ("Brave", @"SOFTWARE\Policies\BraveSoftware\Brave"),
    ];

    /// <summary>The Web Store's own update service — what a force-installed store item uses.</summary>
    public const string StoreUpdateUrl = "https://clients2.google.com/service/update2/crx";

    /// <summary>
    /// ExtensionSettings is written as registry subkeys (ExtensionSettings\&lt;id&gt;\installation_mode),
    /// the same form the installer uses. Chrome also accepts one JSON string value of the
    /// same name, but having both on a machine leaves it to Chrome which one wins.
    /// </summary>
    private static string ExtensionKey(string id) => $@"ExtensionSettings\{id}";
    private const string AllExtensionsKey = @"ExtensionSettings\*";

    /// <summary>
    /// The values that should exist for one browser root, given the settings. An empty
    /// list means "remove everything we own", which is exactly what unenforcing does.
    /// </summary>
    public static IReadOnlyList<PolicyValue> For(Settings settings, string extensionId, string browser)
    {
        if (!settings.Enforce) return [];
        var edge = browser == "Edge";

        var values = new List<PolicyValue>
        {
            // Force-installed: the Remove button is greyed out and the extension comes
            // back if it is somehow removed.
            new("ExtensionInstallForcelist", "1", $"{extensionId};{StoreUpdateUrl}"),
            // ExtensionSettings overrides the forcelist for any id it names. Installs from
            // before 0.5.4 name ours normal_installed, which would quietly undo the
            // forcelist, so the per-id entry has to say force_installed too.
            ForceInstalled(extensionId),
            UpdateUrl(extensionId),
        };

        if (settings.BlockIncognito)
        {
            // There is no policy to allow one extension in incognito, so private windows
            // are switched off instead — otherwise they are an unfiltered browser.
            values.Add(new("", edge ? "InPrivateModeAvailability" : "IncognitoModeAvailability", 1));
            // A fresh profile or guest session would also start unfiltered.
            values.Add(new("", "BrowserGuestModeEnabled", 0));
            values.Add(new("", "BrowserAddPersonEnabled", 0));
            // Brave's Tor windows are private windows with a different name.
            if (browser == "Brave") values.Add(new("", "TorDisabled", 1));
        }

        if (settings.BlockDevTools)
        {
            // 2 = disallowed everywhere. Without this the blur and the fail-closed overlay
            // are both an Inspect → Delete away.
            values.Add(new("", "DeveloperToolsAvailability", 2));
        }

        if (settings.BlockOtherExtensions)
        {
            // Block everything except ours: a proxy, VPN or "disable CSS" extension can
            // otherwise undo the filtering from inside the browser. Ours is exempt by its
            // own force_installed entry above.
            values.Add(new(AllExtensionsKey, "installation_mode", "blocked"));
        }

        return values;
    }

    // Released by deleting, not by reverting to normal_installed: that mode hides the
    // Remove button too, so "enforcement off" would still mean "can't remove it". This
    // also clears the normal_installed entry installers before 0.5.4 wrote. Note that
    // browsers uninstall an extension when its force-install is lifted; turning
    // enforcement off can therefore remove it, to be re-added from the store.
    private static PolicyValue ForceInstalled(string id) =>
        new(ExtensionKey(id), "installation_mode", "force_installed");

    private static PolicyValue UpdateUrl(string id) =>
        new(ExtensionKey(id), "update_url", StoreUpdateUrl);

    /// <summary>Every value this layer may ever write, so unenforcing can clean up fully.</summary>
    public static IReadOnlyList<PolicyValue> AllOwned(string extensionId) =>
    [
        new("ExtensionInstallForcelist", "1", $"{extensionId};{StoreUpdateUrl}"),
        ForceInstalled(extensionId),
        UpdateUrl(extensionId),
        new(AllExtensionsKey, "installation_mode", "blocked"),
        new("", "IncognitoModeAvailability", 1),
        new("", "InPrivateModeAvailability", 1),
        new("", "BrowserGuestModeEnabled", 0),
        new("", "BrowserAddPersonEnabled", 0),
        new("", "TorDisabled", 1),
        new("", "DeveloperToolsAvailability", 2),
        // 0.5.x dev builds wrote ExtensionSettings as one JSON string. Never wanted now,
        // so listing it here makes the next reconcile delete it.
        new("", "ExtensionSettings", ""),
    ];
}
