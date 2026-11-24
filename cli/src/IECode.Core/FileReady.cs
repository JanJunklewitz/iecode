using System.Diagnostics;

namespace IECode.Core;

/// <summary>
/// Waits until a file another process writes is complete: it can be opened exclusively and keeps its size between two
/// looks. XAE may still write a saved library when its COM call returns; RepTool must not install half a file.
/// </summary>
public static class FileReady
{
    public static void Wait(string path, TimeSpan timeout, TimeSpan? poll = null)
    {
        var step = poll ?? TimeSpan.FromMilliseconds(200);
        var clock = Stopwatch.StartNew();
        long last = -1;
        while (true)
        {
            try
            {
                using var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
                if (s.Length > 0 && s.Length == last) return;
                last = s.Length;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { last = -1; }
            if (clock.Elapsed > timeout)
                throw new IECodeException(ExitCodes.LibraryFailed, $"'{path}' was not complete after {timeout.TotalSeconds:0} s.",
                    "TwinCAT may still be writing it; install it later with: iecode lib install <file>.");
            Thread.Sleep(step);
        }
    }
}

/// <summary>The global <c>--timeout</c> in seconds: 1 up to what a wait handle accepts (about 24 days).</summary>
public static class TimeoutSetting
{
    public const int MaxSeconds = int.MaxValue / 1000;

    public static TimeSpan? FromSeconds(int? seconds) => seconds switch
    {
        null => null,
        < 1 or > MaxSeconds => throw new IECodeException(ExitCodes.Usage, $"--timeout {seconds} is out of range.", $"Use 1 to {MaxSeconds} seconds."),
        int s => TimeSpan.FromSeconds(s),
    };
}
