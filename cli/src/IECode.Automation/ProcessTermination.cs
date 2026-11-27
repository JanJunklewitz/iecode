using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace IECode.Automation;

public enum ProcessEnd
{
    /// <summary>The process was ended and its exit is confirmed.</summary>
    Ended,
    /// <summary>There is no such process (anymore): it had ended, or the PID belongs to another process now. Nothing was touched.</summary>
    Gone,
    /// <summary>The process could not be opened or ended, or it did not end in time.</summary>
    Failed,
}

/// <summary>
/// Ends a process by PID only when it is still the process that was recorded. One handle (query, terminate and
/// synchronize rights) serves the creation-time check, the termination and the wait, and a process the handle refers to
/// cannot get a new identity while the handle is open: a PID that Windows reuses between the check and the kill is never hit.
/// <see cref="System.Diagnostics.Process"/> does not give that guarantee, because its time and kill calls may open the process separately.
/// </summary>
[SupportedOSPlatform("windows")]
public static class ProcessTermination
{
    /// <param name="startedUtc">The creation time recorded for the process; a process with another creation time is left alone.</param>
    /// <param name="detail">Why it failed (or was not touched), for the log.</param>
    public static ProcessEnd End(int pid, DateTime startedUtc, TimeSpan wait, out string? detail)
    {
        detail = null;
        using var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, false, pid);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == ERROR_INVALID_PARAMETER) return ProcessEnd.Gone;   // no process with this PID
            detail = new Win32Exception(error).Message;
            return ProcessEnd.Failed;
        }

        // an exited process still opens while somebody holds a handle: it is gone all the same
        if (WaitForSingleObject(handle, 0) == WAIT_OBJECT_0) return ProcessEnd.Gone;
        if (!GetProcessTimes(handle, out var creation, out _, out _, out _))
        {
            detail = $"reading the start time failed: {new Win32Exception(Marshal.GetLastWin32Error()).Message}";
            return ProcessEnd.Failed;
        }
        var actual = DateTime.FromFileTimeUtc(creation);
        if (actual != startedUtc)
        {
            detail = "it is another process now";
            return ProcessEnd.Gone;
        }

        if (!TerminateProcess(handle, 1))
        {
            var error = Marshal.GetLastWin32Error();
            // the process ended between the check and the call
            if (WaitForSingleObject(handle, 0) == WAIT_OBJECT_0) return ProcessEnd.Ended;
            detail = new Win32Exception(error).Message;
            return ProcessEnd.Failed;
        }
        var ms = wait <= TimeSpan.Zero ? 0 : (int)Math.Min(wait.TotalMilliseconds, int.MaxValue - 1);
        if (WaitForSingleObject(handle, ms) == WAIT_OBJECT_0) return ProcessEnd.Ended;
        detail = $"it did not end within {wait.TotalSeconds:0} s";
        return ProcessEnd.Failed;
    }

    private const uint PROCESS_TERMINATE = 0x0001, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0;
    private const int ERROR_INVALID_PARAMETER = 87;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle handle, int milliseconds);
}
