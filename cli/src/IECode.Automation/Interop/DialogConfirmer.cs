using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using IECode.Core;

namespace IECode.Automation.Interop;

/// <summary>
/// Watches for known modal dialogs of the XAE shell that would block an unattended run
/// (e.g. "Potential symbol type change detected" during activation) and confirms them with OK.
/// Runs on a background thread while an operation is in progress.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DialogConfirmer : IDisposable
{
    /// <summary>
    /// Window titles that are confirmed with OK. Confirming keeps mapping information on type changes.
    /// Only the English XAE title is known so far; add localized titles here once verified.
    /// </summary>
    public static readonly string[] KnownTitles =
    [
        "Potential symbol type change detected",
    ];

    private readonly CancellationTokenSource _stop = new();
    private readonly Task _loop;
    private readonly Reporter _log;

    private DialogConfirmer(Reporter log)
    {
        _log = log;
        _loop = Task.Run(() => Watch(_stop.Token));
    }

    public static DialogConfirmer Start(Reporter log) => new(log);

    private async Task Watch(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            foreach (var title in KnownTitles)
            {
                var hwnd = FindWindow(null, title);
                if (hwnd == IntPtr.Zero) continue;
                _log.Warn($"Dialog \"{title}\" confirmed with OK.");
                PostMessage(hwnd, WM_COMMAND, IDOK, IntPtr.Zero);
            }
            try { await Task.Delay(300, ct); } catch (OperationCanceledException) { break; }
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        try { _loop.Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { }
        _stop.Dispose();
    }

    private const uint WM_COMMAND = 0x0111;
    private static readonly IntPtr IDOK = 1;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
