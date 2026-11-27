using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace IECode.Automation.Interop;

/// <summary>
/// The Win32 job object calls shared by <see cref="SupervisedProcess"/> (one job per RepTool run) and
/// <see cref="JobObject"/> (one job for the iecode process, holding its XAE shells): both need a kill-on-close job.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class JobNative
{
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    /// <summary>A child that starts with CREATE_BREAKAWAY_FROM_JOB still starts, outside the job.</summary>
    public const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;

    /// <summary>
    /// A job object that ends every process in it when its last handle closes. Zero when Windows refused: <paramref name="step"/>
    /// names the call that failed and <paramref name="error"/> its Win32 error.
    /// </summary>
    public static IntPtr CreateKillOnClose(bool breakawayOk, out string step, out int error)
    {
        step = "";
        error = 0;
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            (step, error) = ("creating the job object", Marshal.GetLastWin32Error());
            return IntPtr.Zero;
        }
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (breakawayOk ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, ptr, false);
            if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size)) return job;
            (step, error) = ("limiting the job object", Marshal.GetLastWin32Error());
            CloseHandle(job);
            return IntPtr.Zero;
        }
        finally { Marshal.FreeHGlobal(ptr); }
    }

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
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
