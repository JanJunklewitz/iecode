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
            if (AssignProcessToJobObject(job, process.Handle)) return true;
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
        Job.Value != IntPtr.Zero && IsProcessInJob(process.Handle, Job.Value, out var inJob) && inJob;

    private static IntPtr Create()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // BREAKAWAY_OK: a child the shell starts with CREATE_BREAKAWAY_FROM_JOB still starts (outside the job)
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size)) return job;
            CloseHandle(job);
            return IntPtr.Zero;
        }
        finally { Marshal.FreeHGlobal(ptr); }
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
}
