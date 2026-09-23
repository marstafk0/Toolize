using Toolize.Core;
using Xunit;

namespace Toolize.Tests;

/// <summary>
/// Which changes count as weakening. Getting this wrong is how a lock quietly stops
/// locking, so each direction is pinned down explicitly.
/// </summary>
public sealed class SettingsPolicyTests
{
    private static readonly Settings Base = Settings.Default;

    [Fact]
    public void Turning_protection_off_is_weakening()
    {
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { Enabled = false }));
        Assert.False(SettingsPolicy.IsWeakening(Base with { Enabled = false }, Base));
    }

    [Theory]
    [InlineData(Preset.Strict, Preset.Balanced, true)]
    [InlineData(Preset.Balanced, Preset.Relaxed, true)]
    [InlineData(Preset.Relaxed, Preset.Strict, false)]
    [InlineData(Preset.Balanced, Preset.Balanced, false)]
    public void Lowering_sensitivity_is_weakening(Preset from, Preset to, bool weakening) =>
        Assert.Equal(weakening, SettingsPolicy.IsWeakening(Base with { Preset = from }, Base with { Preset = to }));

    [Fact]
    public void Safe_reveal_to_detect_then_blur_is_weakening()
    {
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { Mode = RevealMode.Fast }));
        Assert.False(SettingsPolicy.IsWeakening(Base with { Mode = RevealMode.Fast }, Base));
    }

    [Fact]
    public void Turning_off_site_blocking_is_weakening() =>
        Assert.True(SettingsPolicy.IsWeakening(Base, Base with { BlockAdultSites = false }));

    [Fact]
    public void Weakenings_are_listed_for_the_user()
    {
        var reasons = SettingsPolicy.Weakenings(Base, Base with { Enabled = false, BlockAdultSites = false });
        Assert.Contains("turning protection off", reasons);
        Assert.Contains("turning off adult-site blocking", reasons);
    }
}

public sealed class SecretsTests
{
    [Fact]
    public void Recovery_codes_are_readable_and_unambiguous()
    {
        var code = Secrets.NewRecoveryCode();
        Assert.Matches("^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$", code);
        Assert.DoesNotContain('O', code); // no characters that get misread when written down
        Assert.DoesNotContain('I', code);
    }

    [Fact]
    public void Recovery_codes_normalise_to_the_same_value_however_they_are_typed()
    {
        var code = Secrets.NewRecoveryCode();
        Assert.Equal(Secrets.Normalise(code), Secrets.Normalise(code.ToLowerInvariant().Replace("-", " ")));
    }

    [Fact]
    public void Secrets_are_random_and_hash_stably()
    {
        var a = Secrets.NewSecret();
        Assert.NotEqual(a, Secrets.NewSecret());
        Assert.Equal(Secrets.Hash(a), Secrets.Hash(a));
        Assert.NotEqual(Secrets.Hash(a), Secrets.Hash(Secrets.NewSecret()));
    }
}

public sealed class StateStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "toolize-state", Guid.NewGuid().ToString("n")[..8]);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Settings_and_keys_survive_a_restart()
    {
        var store = new StateStore(_dir);
        store.UpdateSettings(Settings.Default with { Preset = Preset.Strict });
        store.AddKey(new EnrolledKey { Id = "abc", Name = "key", SecretHash = "hash", Counter = 1 });

        var reopened = new StateStore(_dir);
        Assert.Equal(Preset.Strict, reopened.Settings.Preset);
        Assert.Single(reopened.Keys);
        Assert.Equal("key", reopened.Keys[0].Name);
    }

    [Fact]
    public void A_corrupt_state_file_falls_back_to_protective_defaults()
    {
        var store = new StateStore(_dir);
        store.UpdateSettings(Settings.Default with { Enabled = false });
        File.WriteAllText(Path.Combine(_dir, "state.dat"), "this is not encrypted json");

        var reopened = new StateStore(_dir);
        Assert.True(reopened.Settings.Enabled); // fail safe, not fail open
        Assert.Contains(reopened.Notes, n => n.Contains("unreadable"));
    }

    [Fact]
    public void A_recovery_code_works_once_and_clears_the_keys()
    {
        var store = new StateStore(_dir);
        store.AddKey(new EnrolledKey { Id = "abc", Name = "key", SecretHash = "hash", Counter = 1 });
        var code = Secrets.NewRecoveryCode();
        store.SetRecoveryCode(code);

        Assert.False(store.UseRecoveryCode("WRONG-CODE-HERE-XXXXX"));
        Assert.True(store.HasRecoveryCode);

        Assert.True(store.UseRecoveryCode(code.ToLowerInvariant()));
        Assert.Empty(store.Keys);
        Assert.False(store.HasRecoveryCode);
        Assert.False(store.UseRecoveryCode(code)); // burned
    }
}
