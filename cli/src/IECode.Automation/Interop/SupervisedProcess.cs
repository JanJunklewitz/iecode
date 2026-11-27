using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace IECode.Automation.Interop;

/// <summary>
/// A child process that is under iecode's control from its first instruction: it is created suspended, put into its own
/// job object with kill-on-close, and only then resumed. Whatever happens afterwards (iecode killed, a timeout, a failed
/// bookkeeping step), the child and everything it starts ends with the job, so it cannot keep writing unsupervised.
/// Standard output and error are read through pipes; <see cref="WaitForOutput"/> is bounded, because a descendant that
/// keeps a pipe handle open must not block the caller.
/// </summary>
/// <remarks>
/// Used for RepTool (the library repository lock). The XAE shell's own job object (a different lifetime: one job for the
/// process) lives elsewhere and is not related to this class.
/// </remarks>
[SupportedOSPlatform("windows")]
internal sealed class SupervisedProcess : IDisposable
{
    private readonly IntPtr _job;
    private IntPtr _process;
    private readonly Task _stdout, _stderr;
    private bool _disposed;

    public int Id { get; }

    /// <summary>Creation time of the process (UTC ticks), to tell it from a later process that reuses the PID.</summary>
    public long StartTicksUtc { get; }

    private SupervisedProcess(IntPtr job, IntPtr process, int id, long startTicksUtc, Task stdout, Task stderr)
    {
        _job = job;
        _process = process;
        Id = id;
        StartTicksUtc = startTicksUtc;
        _stdout = stdout;
        _stderr = stderr;
    }

    /// <summary>
    /// Starts <paramref name="exe"/> suspended, ties it to a kill-on-close job and resumes it. <paramref name="whileSuspended"/>
    /// runs after the job holds the process and before its first instruction (bookkeeping that must exist before the
    /// child can write); when it throws, the child is killed and never ran. Any failure leaves no child behind.
    /// </summary>
    public static SupervisedProcess Start(string exe, string arguments, Action<string> onOutput, Action<string> onError, Action<SupervisedProcess>? whileSuspended = null)
    {
        var job = CreateJob();
        var jobOwned = true;   // false once the SupervisedProcess owns (and closes) it
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, nul = IntPtr.Zero;
        var info = new PROCESS_INFORMATION();
        var started = false;
        try
        {
            CreatePipe(out outRead, out outWrite);
            CreatePipe(out errRead, out errWrite);
            var inheritable = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), InheritHandle = true };
            nul = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inheritable, OPEN_EXISTING, 0, IntPtr.Zero);
            if (nul == INVALID_HANDLE_VALUE) throw Win32("opening NUL");

            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(), dwFlags = STARTF_USESTDHANDLES,
                hStdInput = nul, hStdOutput = outWrite, hStdError = errWrite,
            };
            var commandLine = new StringBuilder($"\"{exe}\" {arguments}");
            if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero, null, ref startup, out info))
                throw Win32($"starting '{exe}'");
            started = true;

            // the child holds no instruction yet: tie it to the job first, so nothing it does can outlive iecode
            if (!JobNative.AssignProcessToJobObject(job, info.hProcess)) throw Win32("putting the process into its job");

            var childStart = ProcessStartTicks(info.hProcess);
            // the pipes' write ends belong to the child now; closing ours lets the readers see the end of the output
            CloseHandle(outWrite); outWrite = IntPtr.Zero;
            CloseHandle(errWrite); errWrite = IntPtr.Zero;
            CloseHandle(nul); nul = IntPtr.Zero;

            var encoding = OutputEncoding();
            var supervised = new SupervisedProcess(job, info.hProcess, (int)info.dwProcessId, childStart,
                Pump(outRead, encoding, onOutput), Pump(errRead, encoding, onError));
            outRead = errRead = IntPtr.Zero;   // owned by the readers now
            jobOwned = false;
            try
            {
                whileSuspended?.Invoke(supervised);
                if (ResumeThread(info.hThread) == unchecked((uint)-1)) throw Win32("resuming the process");
            }
            catch
            {
                supervised.Dispose();   // closes the job: the suspended child dies without having run
                info.hProcess = IntPtr.Zero;
                throw;
            }
            CloseHandle(info.hThread);
            return supervised;
        }
        catch
        {
            if (started) { TerminateProcess(info.hProcess, 1); }
            if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread);
            if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess);
            foreach (var h in new[] { outRead, outWrite, errRead, errWrite, nul }) if (h != IntPtr.Zero) CloseHandle(h);
            if (jobOwned) CloseHandle(job);
            throw;
        }
    }

    /// <summary>Waits for the process itself (not its output); false when it still runs after <paramref name="timeout"/>.</summary>
    public bool WaitForExit(TimeSpan timeout) => WaitForSingleObject(_process, ToMilliseconds(timeout)) == WAIT_OBJECT_0;

    public bool HasExited => WaitForSingleObject(_process, 0) == WAIT_OBJECT_0;

    public int ExitCode => GetExitCodeProcess(_process, out var code) ? (int)code : throw Win32("reading the exit code");

    /// <summary>
    /// Ends the process and everything it started. True once the process is gone (within <paramref name="wait"/>); false when
    /// it is still running, e.g. because Windows could not end it.
    /// </summary>
    public bool Terminate(TimeSpan wait)
    {
        JobNative.TerminateJobObject(_job, 1);
        return WaitForExit(wait);
    }

    /// <summary>
    /// Waits for the end of the redirected output, at most <paramref name="timeout"/>. False when a descendant still holds
    /// a pipe open; the caller then ends the job instead of waiting for it.
    /// </summary>
    public bool WaitForOutput(TimeSpan timeout) => Task.WaitAll([_stdout, _stderr], timeout);

    /// <summary>Closes the job (which ends the process and its descendants if they still run) and the process handle.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        CloseHandle(_job);   // KILL_ON_JOB_CLOSE
        if (_process != IntPtr.Zero) CloseHandle(_process);
        _process = IntPtr.Zero;
        // the job is gone, so the pipes close and the readers end; do not wait longer than a moment for them
        Task.WaitAll([_stdout, _stderr], TimeSpan.FromSeconds(2));
    }

    private static Task Pump(IntPtr readHandle, Encoding encoding, Action<string> onLine)
    {
        var reader = new StreamReader(new FileStream(new SafeFileHandle(readHandle, ownsHandle: true), FileAccess.Read, 4096, isAsync: false), encoding);
        return Task.Run(() =>
        {
            try
            {
                using (reader)
                    for (var line = reader.ReadLine(); line is not null; line = reader.ReadLine())
                        onLine(line);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException) { }   // the pipe was closed under us
        });
    }

    private static Encoding OutputEncoding()
    {
        try { return Console.OutputEncoding; }
        catch (IOException) { return Encoding.UTF8; }
    }

    private static int ToMilliseconds(TimeSpan t) =>
        t <= TimeSpan.Zero ? 0 : t.TotalMilliseconds >= int.MaxValue - 1 ? int.MaxValue - 1 : (int)t.TotalMilliseconds;

    private static Win32Exception Win32(string what) => new(Marshal.GetLastWin32Error(), $"Windows failed {what}.");

    private static IntPtr CreateJob()
    {
        var job = JobNative.CreateKillOnClose(breakawayOk: false, out var step, out var error);
        return job != IntPtr.Zero ? job : throw new Win32Exception(error, $"Windows failed {step}.");
    }

    /// <summary>An anonymous pipe whose write end the child inherits and whose read end stays ours.</summary>
    private static void CreatePipe(out IntPtr read, out IntPtr write)
    {
        var attributes = new SECURITY_ATTRIBUTES { Length = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), InheritHandle = true };
        if (!CreatePipe(out read, out write, ref attributes, 0)) throw Win32("creating a pipe");
        if (!SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0)) throw Win32("protecting a pipe");
    }

    private static long ProcessStartTicks(IntPtr process)
    {
        if (!GetProcessTimes(process, out var creation, out _, out _, out _)) throw Win32("reading the process start time");
        return DateTime.FromFileTimeUtc(creation).Ticks;
    }

    private const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
    private const int STARTF_USESTDHANDLES = 0x100;
    private const uint HANDLE_FLAG_INHERIT = 1;
    private const uint GENERIC_READ = 0x80000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, WAIT_OBJECT_0 = 0;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string? applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string? currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
