using System.Runtime.InteropServices;

namespace Toolize.Service;

/// <summary>
/// Shows a message box in the logged-in user's session.
///
/// A SYSTEM service runs in session 0, which has no desktop, so anything it "displays"
/// is invisible. WTSSendMessage is the supported way across that boundary — without it
/// the watchdog would close a browser with no explanation on screen, which is exactly
/// the kind of silent behaviour this product shouldn't have.
/// </summary>
internal static class SessionNotifier
{
    private const int MbOk = 0x0;
    private const int MbIconWarning = 0x30;
    private const int MbSetForeground = 0x10000;
    private const int MbTopmost = 0x40000;

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool WTSSendMessageW(
        IntPtr hServer, int sessionId,
        string title, int titleLength,
        string message, int messageLength,
        int style, int timeoutSeconds, out int response, bool wait);

    [DllImport("kernel32.dll")]
    private static extern int WTSGetActiveConsoleSessionId();

    public static void Show(string title, string message, int timeoutSeconds = 30)
    {
        var session = WTSGetActiveConsoleSessionId();
        if (session < 0) return; // nobody logged in; the log is the only audience

        WTSSendMessageW(
            IntPtr.Zero, session,
            title, title.Length * 2,
            message, message.Length * 2,
            MbOk | MbIconWarning | MbSetForeground | MbTopmost,
            timeoutSeconds, out _, wait: false);
    }
}
