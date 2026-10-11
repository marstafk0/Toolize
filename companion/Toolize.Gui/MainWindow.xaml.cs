using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Toolize.Core;

namespace Toolize.Gui;

/// <summary>
/// The whole GUI. It renders what the service reports and forwards what the user asks
/// for — it decides nothing itself, so there is no state here worth tampering with.
/// Every refusal (a change blocked by the lock) comes back from the service.
/// </summary>
public partial class MainWindow : Window
{
    private readonly PipeClient _client;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(2) };
    private StatusReport? _status;
    /// <summary>Guards the moment we write the service's values into the controls.</summary>
    private bool _syncing;

    private static readonly Dictionary<Preset, string> PresetHints = new()
    {
        [Preset.Strict] = "Blurs more. Expect some false positives on beach, sport and art photos.",
        [Preset.Balanced] = "The recommended starting point.",
        [Preset.Relaxed] = "Only clear explicit content. Fewer false positives.",
    };

    public MainWindow()
    {
        InitializeComponent();
        var dev = Environment.GetCommandLineArgs().Contains("--dev");
        _client = new PipeClient(Protocol.PipeName(dev));
        _timer.Tick += async (_, _) => await RefreshAsync();
        Loaded += async (_, _) =>
        {
            await RefreshAsync();
            _timer.Start();
        };
    }

    private async Task RefreshAsync()
    {
        try
        {
            var response = await _client.SendAsync(Verbs.Status);
            _status = response.DataAs<StatusReport>();
            if (_status is not null) Render(_status);
        }
        catch
        {
            StatusText.Text = "The Toolize service isn't running. Protection may be off.";
            StatusText.Foreground = (Brush)FindResource("Bad");
        }
    }

    private void Render(StatusReport s)
    {
        _syncing = true;
        try
        {
            VersionText.Text = $"v{s.Version}";
            ChannelText.Text = $"{s.Channel} channel";

            StatusText.Text = s.Settings.Enabled ? "Protection is on." : "Protection is OFF.";
            StatusText.Foreground = (Brush)FindResource(s.Settings.Enabled ? "Ink" : "Bad");

            EnabledBox.IsChecked = s.Settings.Enabled;
            PresetStrict.IsChecked = s.Settings.Preset == Preset.Strict;
            PresetBalanced.IsChecked = s.Settings.Preset == Preset.Balanced;
            PresetRelaxed.IsChecked = s.Settings.Preset == Preset.Relaxed;
            ModeSafe.IsChecked = s.Settings.Mode == RevealMode.Safe;
            ModeFast.IsChecked = s.Settings.Mode == RevealMode.Fast;
            BlockSitesBox.IsChecked = s.Settings.BlockAdultSites;
            AllowLiveBox.IsChecked = s.Settings.AllowLiveStreams;
            PresetHint.Text = PresetHints[s.Settings.Preset];
            ModeHint.Text = s.Settings.Mode == RevealMode.Safe
                ? "Images stay hidden until they've been checked. Nothing flashes on screen."
                : "Images appear immediately and are blurred once flagged. Faster, but content can flash.";

            ExtensionText.Text = s.Extension.Connected
                ? $"Connected (v{s.Extension.Version}{(s.Extension.Browsers.Count > 0 ? $" in {string.Join(", ", s.Extension.Browsers)}" : "")}) — {s.Extension.Blocked} blocked of {s.Extension.Checked} checked."
                : "Not connected. Open your browser; if this persists, run `toolize doctor`.";
            ExtensionText.Foreground = (Brush)FindResource(s.Extension.Connected ? "Ink" : "Muted");

            LockText.Text = s.Lock.Enrolled
                ? s.Lock.KeyPresent
                    ? $"Unlocked — {s.Lock.KeyName} is plugged in. Changes that weaken protection are allowed."
                    : "Locked. Plug in your key to change anything that weakens protection."
                : "No key enrolled, so every setting can be changed freely.";
            LockText.Foreground = (Brush)FindResource(s.Lock.Enrolled && !s.Lock.KeyPresent ? "Accent" : "Ink");
            EnrollButton.Content = s.Keys.Count == 0 ? "Set up a USB key" : "Add another key";
            RevokeButton.Visibility = s.Keys.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            LockHint.Text = s.Keys.Count == 0
                ? "A dedicated USB key gates every change that weakens protection. Removing it re-locks immediately."
                : string.Join(", ", s.Keys.Select(k => k.Name)) +
                  (s.HasRecoveryCode ? " · recovery code issued" : " · NO recovery code — losing every key means reinstalling");

            EnforceBox.IsChecked = s.Settings.Enforce;
            BlockIncognitoBox.IsChecked = s.Settings.BlockIncognito;
            BlockOtherExtBox.IsChecked = s.Settings.BlockOtherExtensions;
            BlockDevToolsBox.IsChecked = s.Settings.BlockDevTools;
            WatchdogOff.IsChecked = s.Settings.Watchdog == Watchdog.Off;
            WatchdogWarn.IsChecked = s.Settings.Watchdog == Watchdog.Warn;
            WatchdogClose.IsChecked = s.Settings.Watchdog == Watchdog.Close;
            EnforceOptions.IsEnabled = s.Settings.Enforce;
            EnforceHint.Text = s.Settings.Enforce
                ? $"{s.Enforcement.Summary}. Turning this off needs your key, and the browser may remove the extension — add it again from the Web Store if you want it back."
                : "Off. The extension can be disabled or removed in the browser like any other.";
            WatchdogHint.Text = s.Settings.Enforce ? s.Enforcement.Watchdog : "";

            if (s.Update is { Available: true } update)
            {
                UpdateText.Text = $"Version {update.Version} is available.{(update.Notes is null ? "" : $"\n{update.Notes}")}";
                UpdateButton.Content = $"Install {update.Version}";
            }
            else
            {
                UpdateText.Text = s.Update?.Notes is { Length: > 0 } note && s.Update is { Available: false }
                    ? $"Up to date (v{s.Version}). {note}"
                    : $"Up to date (v{s.Version}).";
                UpdateButton.Content = "Check for updates";
            }

            NotesText.Text = s.Notes.Count == 0
                ? "Nothing yet."
                : string.Join('\n', s.Notes.TakeLast(8).Select(Shorten));
        }
        finally
        {
            _syncing = false;
        }
    }

    /// <summary>Notes are stored with a full ISO timestamp; the UI only needs the day and time.</summary>
    private static string Shorten(string note) =>
        DateTimeOffset.TryParse(note.Split(' ')[0], out var when)
            ? $"{when.LocalDateTime:MMM d HH:mm}  {note[(note.IndexOf(' ') + 1)..]}"
            : note;

    private async void OnSettingChanged(object sender, RoutedEventArgs e)
    {
        if (_syncing || _status is null) return;

        var next = _status.Settings with
        {
            Enabled = EnabledBox.IsChecked == true,
            Preset = PresetStrict.IsChecked == true ? Preset.Strict
                : PresetRelaxed.IsChecked == true ? Preset.Relaxed
                : Preset.Balanced,
            Mode = ModeFast.IsChecked == true ? RevealMode.Fast : RevealMode.Safe,
            BlockAdultSites = BlockSitesBox.IsChecked == true,
            AllowLiveStreams = AllowLiveBox.IsChecked == true,
            Enforce = EnforceBox.IsChecked == true,
            BlockIncognito = BlockIncognitoBox.IsChecked == true,
            BlockOtherExtensions = BlockOtherExtBox.IsChecked == true,
            BlockDevTools = BlockDevToolsBox.IsChecked == true,
            Watchdog = WatchdogClose.IsChecked == true ? Watchdog.Close
                : WatchdogOff.IsChecked == true ? Watchdog.Off
                : Watchdog.Warn,
        };

        try
        {
            var response = await _client.SendAsync(Verbs.SetSettings, new SetSettingsArgs(next));
            if (!response.Ok)
            {
                MessageBox.Show(this, response.Error, response.Code == "locked" ? "Locked" : "Toolize",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Toolize", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            await RefreshAsync(); // always re-render from the service, never from local state
        }
    }

    private async void OnEnrollClicked(object sender, RoutedEventArgs e)
    {
        _timer.Stop(); // the wizard drives its own polling
        new EnrollWindow(_client) { Owner = this }.ShowDialog();
        await RefreshAsync();
        _timer.Start();
    }

    private async void OnRevokeClicked(object sender, RoutedEventArgs e)
    {
        var key = _status?.Keys.FirstOrDefault();
        if (key is null) return;
        if (MessageBox.Show(this,
                $"Remove \"{key.Name}\"? If it is your only key, nothing will be gated any more.",
                "Remove key", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;

        var response = await _client.SendAsync(Verbs.RevokeKey, new RevokeKeyArgs(key.Id));
        if (!response.Ok) MessageBox.Show(this, response.Error, "Locked", MessageBoxButton.OK, MessageBoxImage.Warning);
        await RefreshAsync();
    }

    private async void OnUpdateClicked(object sender, RoutedEventArgs e)
    {
        UpdateButton.IsEnabled = false;
        try
        {
            if (_status?.Update is { Available: true })
            {
                UpdateText.Text = "Downloading and installing… the app will restart.";
                var response = await _client.SendAsync(Verbs.ApplyUpdate);
                if (!response.Ok) UpdateText.Text = $"Update failed: {response.Error}";
            }
            else
            {
                UpdateText.Text = "Checking…";
                await _client.SendAsync(Verbs.CheckUpdate);
                await RefreshAsync();
            }
        }
        catch (Exception ex)
        {
            UpdateText.Text = $"Update failed: {ex.Message}";
        }
        finally
        {
            UpdateButton.IsEnabled = true;
        }
    }
}
