using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using IECode.Core;

namespace IECode.Automation.Interop;

/// <summary>
/// Ties the XAE shells iecode starts to the iecode process. The shell is a DCOM server, not a child process, so a
/// killed iecode would leave it running; one process-wide job with kill-on-close (created once, its handle kept open
/// for the process lifetime) ends every assigned shell when iecode ends, however it ends.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class JobObject
{
    private static readonly Lazy<IntPtr> Job = new(Create);

    /// <summary>Puts the process into the job; false (with a Detail line) when that is not possible, e.g. a job that forbids nesting.</summary>
    public static bool TryKillOnClose(Process process, Reporter log)
    {
        try
        {
            var job = Job.Value;
            if (job == IntPtr.Zero)
            {
                log.Detail("Kill-on-close job not available; 'iecode shells kill' ends a shell left behind.");
                return false;
            }
            if (JobNative.AssignProcessToJobObject(job, process.Handle)) return true;
            log.Detail($"Shell process {process.Id} not tied to iecode (Win32 error {Marshal.GetLastWin32Error()}); 'iecode shells kill' ends it if it is left behind.");
            return false;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            log.Detail($"Shell process not tied to iecode: {e.Message}");
            return false;
        }
    }

    /// <summary>The process is in iecode's job (for tests and diagnostics).</summary>
    public static bool Holds(Process process) =>
        Job.Value != IntPtr.Zero && JobNative.IsProcessInJob(process.Handle, Job.Value, out var inJob) && inJob;

    private static IntPtr Create()
    {
        // BREAKAWAY_OK: a child the shell starts with CREATE_BREAKAWAY_FROM_JOB still starts (outside the job)
        return JobNative.CreateKillOnClose(breakawayOk: true, out _, out _);
    }
}
