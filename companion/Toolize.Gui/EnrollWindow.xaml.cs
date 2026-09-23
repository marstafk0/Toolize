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
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(1) };
    private Step _step = Step.Pick;

    public EnrollWindow(PipeClient client)
    {
        InitializeComponent();
        _client = client;
        _poll.Tick += async (_, _) => await OnPollAsync();
        Loaded += async (_, _) => await LoadDrivesAsync();
        Closed += (_, _) => _poll.Stop();
    }

    private async Task LoadDrivesAsync()
    {
        try
        {
            var drives = (await _client.SendAsync(Verbs.Drives)).DataAs<List<DriveOption>>() ?? [];
            DriveList.Items.Clear();
            foreach (var d in drives)
            {
                DriveList.Items.Add(new ListBoxItem
                {
                    Content = $"{d.Letter}   {d.Label}   {d.Bytes / 1_000_000_000.0:F1} GB{(d.HasKey ? "   (already has a Toolize key)" : "")}",
                    Tag = d.Letter,
                    Padding = new Thickness(6),
                });
            }
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
        NextButton.IsEnabled = (DriveList.SelectedItem as ListBoxItem)?.Tag is string;

    private async void OnNext(object sender, RoutedEventArgs e)
    {
        switch (_step)
        {
            case Step.Pick:
                await WriteKeyAsync();
                break;
            case Step.Recovery:
                DialogResult = true;
                Close();
                break;
        }
    }

    private async Task WriteKeyAsync()
    {
        if ((DriveList.SelectedItem as ListBoxItem)?.Tag is not string drive) return;
        NextButton.IsEnabled = false;
        ErrorText.Text = "";
        try
        {
            var response = await _client.SendAsync(Verbs.EnrollKey, new EnrollKeyArgs(drive, KeyName.Text.Trim()));
            if (!response.Ok)
            {
                ErrorText.Text = response.Error;
                NextButton.IsEnabled = true;
                return;
            }
            if (response.Data!.Value.TryGetProperty("recovery", out var code) && code.ValueKind is System.Text.Json.JsonValueKind.String)
                RecoveryCode.Text = code.GetString();

            _step = Step.Unplug;
            StepPick.Visibility = Visibility.Collapsed;
            StepVerify.Visibility = Visibility.Visible;
            StepTitle.Text = "Check that it locks";
            StepHint.Text = "This proves the lock really follows the key, rather than taking our word for it.";
            NextButton.Visibility = Visibility.Collapsed;
            _poll.Start();
        }
        catch (Exception ex)
        {
            ErrorText.Text = ex.Message;
            NextButton.IsEnabled = true;
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

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
