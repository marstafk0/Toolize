using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Toolize.Core;

namespace Toolize.Gui;

/// <summary>
/// The USB key setup wizard: pick a drive, write the key, prove it actually locks, then
/// show the recovery code once.
///
/// The unplug/replug step isn't ceremony. It's the only way the user sees with their own
/// eyes that removing the key re-locks the machine — and it catches the case where the
/// service can't see the drive at all, which would otherwise surface much later as a
/// mysterious refusal.
/// </summary>
public partial class EnrollWindow : Window
{
    private enum Step { Pick, Unplug, Replug, Recovery }

    private readonly PipeClient _client;
    private readonly bool _hasExistingKeys;
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly DispatcherTimer _drivePoll = new() { Interval = TimeSpan.FromSeconds(2) };
    private Step _step = Step.Pick;
    private bool _acknowledgedRecovery;

    public EnrollWindow(PipeClient client, bool hasExistingKeys = false)
    {
        InitializeComponent();
        _client = client;
        _hasExistingKeys = hasExistingKeys;
        _poll.Tick += async (_, _) => await OnPollAsync();
        _drivePoll.Tick += async (_, _) =>
        {
            if (_step == Step.Pick) await LoadDrivesAsync();
        };
        Loaded += async (_, _) =>
        {
            await LoadDrivesAsync();
            _drivePoll.Start();
        };
        Closing += OnWindowClosing;
        Closed += (_, _) =>
        {
            _poll.Stop();
            _drivePoll.Stop();
        };
    }

    private async Task LoadDrivesAsync()
    {
        try
        {
            var selectedLetter = ((DriveList.SelectedItem as ListBoxItem)?.Tag as DriveOption)?.Letter;
            var drives = (await _client.SendAsync(Verbs.Drives)).DataAs<List<DriveOption>>() ?? [];
            DriveList.Items.Clear();
            ListBoxItem? toSelect = null;
            foreach (var d in drives)
            {
                var item = new ListBoxItem
                {
                    Content = $"{d.Letter}   {d.Label}   {d.Bytes / 1_000_000_000.0:F1} GB{(d.HasKey ? "   (already has a Toolize key)" : "")}",
                    Tag = d,
                    Padding = new Thickness(6),
                };
                if (selectedLetter is not null && string.Equals(d.Letter, selectedLetter, StringComparison.OrdinalIgnoreCase))
                    toSelect = item;
                DriveList.Items.Add(item);
            }
            if (toSelect is not null) DriveList.SelectedItem = toSelect;
            if (drives.Count == 0)
            {
                DriveList.Items.Add(new ListBoxItem { Content = "No USB drives found — plug one in", IsEnabled = false });
            }
        }
        catch (Exception ex)
        {
            ErrorText.Text = ex.Message;
        }
    }

    private void OnDriveSelected(object sender, SelectionChangedEventArgs e) =>
        NextButton.IsEnabled = (DriveList.SelectedItem as ListBoxItem)?.Tag is DriveOption;

    private async void OnNext(object sender, RoutedEventArgs e)
    {
        switch (_step)
        {
            case Step.Pick:
                await WriteKeyAsync();
                break;
            case Step.Recovery:
                _acknowledgedRecovery = true;
                DialogResult = true;
                Close();
                break;
        }
    }

    private async Task WriteKeyAsync()
    {
        if ((DriveList.SelectedItem as ListBoxItem)?.Tag is not DriveOption driveOption) return;
        if (driveOption.HasKey)
        {
            var confirm = MessageBox.Show(this,
                $"Drive {driveOption.Letter} already holds a Toolize key. Writing a new key here will overwrite it and leave the old key record orphaned until you remove it. Overwrite anyway?",
                "Drive already has a key",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.Yes) return;
        }

        _drivePoll.Stop();
        NextButton.IsEnabled = false;
        ErrorText.Text = "";
        try
        {
            var response = await _client.SendAsync(Verbs.EnrollKey, new EnrollKeyArgs(driveOption.Letter, KeyName.Text.Trim()));
            if (!response.Ok)
            {
                ErrorText.Text = response.Error;
                NextButton.IsEnabled = true;
                _drivePoll.Start();
                return;
            }
            if (response.Data!.Value.TryGetProperty("recovery", out var code) && code.ValueKind is System.Text.Json.JsonValueKind.String)
                RecoveryCode.Text = code.GetString();

            _step = Step.Unplug;
            StepPick.Visibility = Visibility.Collapsed;
            StepVerify.Visibility = Visibility.Visible;
            StepTitle.Text = "Check that it locks";
            StepHint.Text = "This proves the lock really follows the key, rather than taking our word for it.";
            VerifyText.Text = _hasExistingKeys
                ? "Key written. Now unplug ALL Toolize keys so we can check that Toolize locks without them."
                : "Key written. Now unplug the drive so we can check that Toolize locks without it.";
            VerifyState.Text = _hasExistingKeys
                ? "Waiting for you to unplug all Toolize keys…"
                : "Waiting for you to unplug it…";
            NextButton.Visibility = Visibility.Collapsed;
            _poll.Start();
        }
        catch (Exception ex)
        {
            ErrorText.Text = ex.Message;
            NextButton.IsEnabled = true;
            _drivePoll.Start();
        }
    }

    /// <summary>Watches the real lock state as the user unplugs and replugs the drive.</summary>
    private async Task OnPollAsync()
    {
        LockState? state;
        try
        {
            state = (await _client.SendAsync(Verbs.Status)).DataAs<StatusReport>()?.Lock;
        }
        catch
        {
            return;
        }
        if (state is null) return;

        switch (_step)
        {
            case Step.Unplug when !state.KeyPresent:
                _step = Step.Replug;
                VerifyState.Text = "Locked. Now plug it back in.";
                break;

            case Step.Replug when state.KeyPresent:
                _poll.Stop();
                if (string.IsNullOrEmpty(RecoveryCode.Text))
                {
                    DialogResult = true;
                    Close();
                    return;
                }
                _step = Step.Recovery;
                StepVerify.Visibility = Visibility.Collapsed;
                StepRecovery.Visibility = Visibility.Visible;
                StepTitle.Text = "Your recovery code";
                StepHint.Text = "";
                CancelButton.Visibility = Visibility.Collapsed;
                NextButton.Visibility = Visibility.Visible;
                NextButton.Content = "I've written it down";
                NextButton.IsEnabled = true;
                break;
        }
    }

    private void OnCopyCode(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(RecoveryCode.Text)) return;
        Clipboard.SetText(RecoveryCode.Text);
        CopyCodeButton.Content = "Copied";
    }

    private void OnWindowClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_step == Step.Recovery && !_acknowledgedRecovery)
        {
            var res = MessageBox.Show(this,
                "Have you written down or saved the recovery code? It will never be shown again.",
                "Recovery code",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);
            if (res != MessageBoxResult.Yes)
                e.Cancel = true;
        }
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
