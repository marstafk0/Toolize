using System.Windows;
using System.Windows.Controls;
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
    private bool _wasKeyPresent;
    private string? _updateError;
    /// <summary>Guards the moment we write the service's values into the controls.</summary>
    private bool _syncing;

    private static readonly Dictionary<Preset, string> PresetHints = new()
    {
        [Preset.Strict] = "Blurs more. Expect some false positives on beach, sport and art photos.",
        [Preset.Balanced] = "The recommended starting point.",
        [Preset.Relaxed] = "Only clear explicit content. Fewer false positives.",
    };

    /// <summary>One checkbox per feed toggle, keyed by its setting ("youtube.home").</summary>
    private readonly Dictionary<string, CheckBox> _feedBoxes = new();

    public MainWindow()
    {
        InitializeComponent();
        BuildFeeds();
        var dev = Environment.GetCommandLineArgs().Contains("--dev");
        _client = new PipeClient(Protocol.PipeName(dev));
        _timer.Tick += async (_, _) => await RefreshAsync();
        Loaded += async (_, _) =>
        {
            await RefreshAsync();
            _timer.Start();
        };
    }

    private void BuildFeeds()
    {
        foreach (var site in FeedCatalog.Sites)
        {
            FeedsPanel.Children.Add(new TextBlock { Text = site.Name, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 10, 0, 2) });
            foreach (var toggle in site.Toggles)
            {
                var box = new CheckBox { Content = $"Hide {toggle.Label.ToLowerInvariant()}", ToolTip = toggle.Hint, Margin = new Thickness(0, 4, 0, 0) };
                box.Click += OnSettingChanged;
                _feedBoxes[toggle.Key] = box;
                FeedsPanel.Children.Add(box);
            }
        }
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
            var keyRemovedNow = _wasKeyPresent && !s.Lock.KeyPresent;
            _wasKeyPresent = s.Lock.KeyPresent;

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
            foreach (var (key, box) in _feedBoxes) box.IsChecked = s.Settings.Feeds?.GetValueOrDefault(key) == true;
            WordFilterBox.IsChecked = s.Settings.WordFilter;
            // Don't overwrite what the user is typing on every refresh — unless the key
            // was just removed, which reverts half-applied edits immediately.
            if (keyRemovedNow || !WordsBox.IsKeyboardFocusWithin)
                WordsBox.Text = string.Join(Environment.NewLine, s.Settings.BlockedWords ?? []);
            if (keyRemovedNow || !ChannelsBox.IsKeyboardFocusWithin)
                ChannelsBox.Text = string.Join(Environment.NewLine, s.Settings.TrustedChannels ?? []);
            PresetHint.Text = PresetHints[s.Settings.Preset];
            ModeHint.Text = s.Settings.Mode == RevealMode.Safe
                ? "Images stay hidden until they've been checked. Nothing flashes on screen."
                : "Images appear immediately and are blurred once flagged. Faster, but content can flash.";

            ExtensionText.Text = s.Extension.Connected
                ? $"Connected (v{s.Extension.Version}{(s.Extension.Browsers.Count > 0 ? $" in {string.Join(", ", s.Extension.Browsers)}" : "")}) — {s.Extension.Blocked} blocked of {s.Extension.Checked} checked."
                : "Not connected. Open your browser; if this persists, run `toolize doctor`.";
            ExtensionText.Foreground = (Brush)FindResource(s.Extension.Connected ? "Ink" : "Muted");

            if (s.Extension.Connected && s.Extension.ConnectedBrowsers.Count > 0)
            {
                var synced = s.Extension.ConnectedBrowsers.All(b => b.LastSeen >= s.SettingsChangedAt);
                ExtensionSyncText.Text = $"Browser: {(synced ? "synced" : "syncing…")} (rev {s.SettingsRevision})";
                ExtensionSyncText.Visibility = Visibility.Visible;
            }
            else
            {
                ExtensionSyncText.Visibility = Visibility.Collapsed;
            }

            if (!s.Lock.Enrolled)
            {
                LockText.Text = "No key enrolled, so every setting can be changed freely.";
                LockText.Foreground = (Brush)FindResource("Ink");
            }
            else if (s.Lock.KeyPresent)
            {
                LockText.Text = $"Unlocked — {s.Lock.KeyName} is plugged in. Changes that weaken protection are allowed.";
                LockText.Foreground = (Brush)FindResource("Ink");
            }
            else if (!string.IsNullOrEmpty(s.Lock.KeyName))
            {
                LockText.Text = $"Locked — {s.Lock.KeyName}";
                LockText.Foreground = (Brush)FindResource("Bad");
            }
            else
            {
                LockText.Text = "Locked. Plug in your key to change anything that weakens protection.";
                LockText.Foreground = (Brush)FindResource("Accent");
            }

            EnrollButton.Content = s.Keys.Count == 0 ? "Set up a USB key" : "Add another key";
            LockHint.Text = s.Keys.Count == 0
                ? "A dedicated USB key gates every change that weakens protection. Removing it re-locks immediately."
                : s.HasRecoveryCode
                    ? "Recovery code issued and unused."
                    : "NO recovery code — losing every key means reinstalling.";
            RenderKeys(s.Keys);

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
            UpdateErrorText.Text = _updateError ?? "";
            UpdateErrorText.Visibility = string.IsNullOrEmpty(_updateError) ? Visibility.Collapsed : Visibility.Visible;

            NotesText.Text = s.Notes.Count == 0
                ? "Nothing yet."
                : string.Join('\n', s.Notes.TakeLast(8).Select(Shorten));
        }
        finally
        {
            _syncing = false;
        }
    }

    private void RenderKeys(IReadOnlyList<EnrolledKey> keys)
    {
        KeysPanel.Children.Clear();
        foreach (var k in keys)
        {
            var row = new DockPanel { Margin = new Thickness(0, 6, 0, 0) };
            var removeBtn = new Button
            {
                Content = "Remove",
                Tag = k,
                Background = new SolidColorBrush(Color.FromRgb(0x8A, 0x8A, 0x8A)),
                Padding = new Thickness(10, 4, 10, 4),
            };
            removeBtn.Click += OnRevokeClicked;
            DockPanel.SetDock(removeBtn, Dock.Right);
            row.Children.Add(removeBtn);

            var seenText = k.LastSeen is { } seen
                ? $"last seen {seen.LocalDateTime:yyyy-MM-dd HH:mm}"
                : $"enrolled {k.EnrolledAt.LocalDateTime:yyyy-MM-dd}";
            row.Children.Add(new TextBlock
            {
                Text = $"{k.Name} ({seenText})",
                VerticalAlignment = VerticalAlignment.Center,
            });
            KeysPanel.Children.Add(row);
        }
    }

    private void ShowBanner(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            RefusalBanner.Visibility = Visibility.Collapsed;
            RefusalText.Text = "";
            return;
        }
        RefusalText.Text = message;
        RefusalBanner.Visibility = Visibility.Visible;
    }

    private void OnDismissBanner(object sender, RoutedEventArgs e) => ShowBanner(null);

    /// <summary>Notes are stored with a full ISO timestamp; the UI only needs the day and time.</summary>
    private static string Shorten(string note) =>
        DateTimeOffset.TryParse(note.Split(' ')[0], out var when)
            ? $"{when.LocalDateTime:MMM d HH:mm}  {note[(note.IndexOf(' ') + 1)..]}"
            : note;

    private async void OnSettingChanged(object sender, RoutedEventArgs e)
    {
        if (_syncing || _status is null) return;
        ShowBanner(null);

        var next = _status.Settings with
        {
            Enabled = EnabledBox.IsChecked == true,
            Preset = PresetStrict.IsChecked == true ? Preset.Strict
                : PresetRelaxed.IsChecked == true ? Preset.Relaxed
                : Preset.Balanced,
            Mode = ModeFast.IsChecked == true ? RevealMode.Fast : RevealMode.Safe,
            BlockAdultSites = BlockSitesBox.IsChecked == true,
            AllowLiveStreams = AllowLiveBox.IsChecked == true,
            Feeds = _feedBoxes.ToDictionary(f => f.Key, f => f.Value.IsChecked == true),
            WordFilter = WordFilterBox.IsChecked == true,
            BlockedWords = WordsBox.Text.Split(['\r', '\n']).Select(w => w.Trim()).Where(w => w.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            TrustedChannels = ChannelsBox.Text.Split(['\r', '\n']).Select(w => w.Trim()).Where(w => w.Length > 0)
                .DistinctBy(SettingsPolicy.ChannelKey).ToList(),
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
                ShowBanner(response.Error);
            }
        }
        catch (Exception ex)
        {
            ShowBanner(ex.Message);
        }
        finally
        {
            await RefreshAsync(); // always re-render from the service, never from local state
        }
    }

    private async void OnEnrollClicked(object sender, RoutedEventArgs e)
    {
        ShowBanner(null);
        _timer.Stop(); // the wizard drives its own polling
        new EnrollWindow(_client, hasExistingKeys: (_status?.Keys.Count ?? 0) > 0) { Owner = this }.ShowDialog();
        await RefreshAsync();
        _timer.Start();
    }

    private async void OnRevokeClicked(object sender, RoutedEventArgs e)
    {
        ShowBanner(null);
        var key = (sender as FrameworkElement)?.Tag as EnrolledKey ?? _status?.Keys.FirstOrDefault();
        if (key is null) return;
        if (MessageBox.Show(this,
                $"Remove \"{key.Name}\"? If it is your only key, nothing will be gated any more.",
                "Remove key", MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;

        var response = await _client.SendAsync(Verbs.RevokeKey, new RevokeKeyArgs(key.Id));
        if (!response.Ok) ShowBanner(response.Error);
        await RefreshAsync();
    }

    private async void OnUpdateClicked(object sender, RoutedEventArgs e)
    {
        ShowBanner(null);
        _updateError = null;
        UpdateErrorText.Visibility = Visibility.Collapsed;
        UpdateButton.IsEnabled = false;
        try
        {
            if (_status?.Update is { Available: true })
            {
                UpdateText.Text = "Downloading and installing… the app will restart.";
                var response = await _client.SendAsync(Verbs.ApplyUpdate);
                if (!response.Ok)
                {
                    _updateError = $"Update failed: {response.Error}";
                    if (response.Code == "locked") ShowBanner(response.Error);
                }
            }
            else
            {
                UpdateText.Text = "Checking…";
                await _client.SendAsync(Verbs.CheckUpdate);
            }
        }
        catch (Exception ex)
        {
            _updateError = $"Update failed: {ex.Message}";
        }
        finally
        {
            await RefreshAsync();
            UpdateButton.IsEnabled = true;
        }
    }
}
