using System.Runtime.InteropServices;

namespace IECode.Core;

/// <summary>
/// Makes ANSI escape sequences work in the classic Windows console (conhost). It only interprets them once a
/// program sets ENABLE_VIRTUAL_TERMINAL_PROCESSING; Windows Terminal and PowerShell do that, cmd.exe and a
/// double-clicked exe don't, and the sequences then show up as literal "[2K[2m" text.
/// </summary>
internal static class ConsoleVt
{
    private static readonly Lazy<bool> Enabled = new(TryEnable);

    /// <summary>True when ANSI sequences written to the console will be interpreted.</summary>
    public static bool IsAvailable => Enabled.Value;

    private static bool TryEnable()
    {
        if (!OperatingSystem.IsWindows()) return true;
        try
        {
            // stdout and stderr usually share one screen buffer, but set both: either may be a different console.
            var ok = true;
            foreach (var std in new[] { StdOutputHandle, StdErrorHandle })
            {
                var handle = GetStdHandle(std);
                if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !GetConsoleMode(handle, out var mode))
                    continue; // redirected or no console: nothing to enable for this handle
                if ((mode & EnableVirtualTerminalProcessing) != 0) continue;
                ok &= SetConsoleMode(handle, mode | EnableVirtualTerminalProcessing);
            }
            return ok;
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            return false;
        }
    }

    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const uint EnableVirtualTerminalProcessing = 0x0004;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
}
