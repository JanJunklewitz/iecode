using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using IECode.Core;

namespace IECode.Automation.Interop;

/// <summary>
/// Watches the windows of the XAE shell process while iecode drives it (decisions in <see cref="DialogPolicy"/> and
/// <see cref="DialogTracker"/>): known dialogs are confirmed with OK; an unknown modal dialog is cancelled after 10 s,
/// then closed, then the shell is ended, so the blocked COM call returns and the command fails with the dialog's text.
/// Without a shell process only the known titles are confirmed, and only in processes the caller verified as TwinCAT
/// helpers (<see cref="DialogPolicy.IsTwinCatHelper"/>); with neither, nothing is touched. Polls on its own thread every 300 ms.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DialogWatch : IDisposable
{
    private readonly Process? _shell;
    private readonly int? _pid;
    private readonly Reporter _log;
    private readonly DialogTracker _tracker;
    private readonly DialogTimings _timings;
    private readonly ManualResetEventSlim _stop = new();
    private readonly Thread _thread;
    private readonly HashSet<nint> _confirmed = [];
    private readonly Func<int, bool>? _isHelper;
    private readonly Lock _sync = new();
    private volatile SeenDialog? _cancelled;
    private volatile bool _gaveUp;
    private volatile bool _ended;
    private string? _terminationError;
    private IECodeException? _failure;
    private ShellEnd _failureEnd;
    private readonly ShellOps _ops;
    private readonly uint _callerThread;
    private DateTime _lastCancelCall = DateTime.MinValue;

    private DialogWatch(Process? shell, bool userCanAnswer, Reporter log, DialogTimings? timings, Func<int, bool>? isHelper, ShellOps? ops)
    {
        _ops = ops ?? ShellOps.Real;
        _shell = shell;
        // the thread that drives the shell blocks in the COM call when a dialog stops it: remember it to cancel that call later
        if (shell is not null)
        {
            _callerThread = _ops.CurrentThread();
            _ops.EnableCallCancellation();
        }
        _pid = shell?.Id;
        _isHelper = isHelper;
        _log = log;
        _timings = timings ?? DialogTimings.Default;
        _tracker = new DialogTracker(_pid, userCanAnswer, _timings);
        _thread = new Thread(Loop) { IsBackground = true, Name = "iecode dialog watch" };
        _thread.Start();
    }

    /// <param name="shell">The owned shell process (kept open for the kill on give-up), or null: then only <paramref name="isHelper"/> processes are looked at.</param>
    /// <param name="userCanAnswer">The shell is visible: unknown dialogs are left to the user.</param>
    /// <param name="isHelper">Without a shell process: whether a process is a verified TwinCAT helper whose known dialogs may be confirmed. Null: none is.</param>
    public static DialogWatch Start(Process? shell, bool userCanAnswer, Reporter log, DialogTimings? timings = null, Func<int, bool>? isHelper = null, ShellOps? ops = null) =>
        new(shell, userCanAnswer, log, timings, isHelper, ops);

    /// <summary>The first dialog that was cancelled (or that made the watcher give up).</summary>
    public SeenDialog? Cancelled => _cancelled;

    /// <summary>A dialog did not close and ending the shell was attempted; whether it worked is <see cref="ShellEnded"/>.</summary>
    public bool GaveUp => _gaveUp;

    /// <summary>The shell process was ended and its exit confirmed. False after <see cref="GaveUp"/> means it may still run, blocked.</summary>
    public bool ShellEnded => _ended;

    /// <summary>
    /// The error the command fails with once a dialog was cancelled: the same instance as long as nothing changed, a new one
    /// when the watcher escalated since (cancelled, then ended or failed to end the shell). Waits for an escalation in progress.
    /// </summary>
    public IECodeException? Failure
    {
        get
        {
            lock (_sync)
            {
                if (_cancelled is not { } d) return null;
                var end = !_gaveUp ? ShellEnd.Kept : _ended ? ShellEnd.Ended : ShellEnd.NotEnded;
                if (_failure is null || _failureEnd != end)
                {
                    _failure = DialogPolicy.Failure(d, end, _terminationError);
                    _failureEnd = end;
                }
                return _failure;
            }
        }
    }

    private void Loop()
    {
        while (!_stop.IsSet)
        {
            try { Poll(); CancelBlockedCall(); }
            catch (Exception e) { _log.Detail($"Dialog watch: {e.Message}"); }
            _stop.Wait(300);
        }
    }

    private void Poll()
    {
        var windows = new List<WindowSnapshot>();
        EnumWindows((h, _) =>
        {
            if (Snapshot(h) is { } w) windows.Add(w);
            return true;
        }, IntPtr.Zero);

        foreach (var (d, action) in _tracker.Next(windows, DateTime.UtcNow))
        {
            if (_stop.IsSet) return;
            switch (action)
            {
                case DialogAction.ConfirmOk:
                    if (Post(d, WM_COMMAND, IDOK) && _confirmed.Add(d.Handle)) _log.Warn($"Dialog \"{d.Title}\" confirmed with OK.");
                    break;
                case DialogAction.Cancel:
                    _cancelled ??= d;
                    _log.Warn($"Dialog \"{d.Title}\" cancelled after {_timings.CancelAfter.TotalSeconds:0} s: {(d.Text.Length == 0 ? "(no text)" : d.Text)}");
                    Post(d, WM_COMMAND, IDCANCEL);
                    break;
                case DialogAction.Close:
                    _log.Warn($"Dialog \"{d.Title}\" did not close on Cancel; sending WM_CLOSE.");
                    Post(d, WM_CLOSE, IntPtr.Zero);
                    break;
                case DialogAction.GiveUp:
                    EndShell(d);
                    break;
            }
        }
    }

    /// <summary>
    /// Ends the shell and records what came of it, under the lock <see cref="Failure"/> takes, so a command that wakes up
    /// from the dead shell reads the final outcome and not a half-finished one. A failure to end it is a warning, not
    /// a verbose line: the shell may still run, blocked on the dialog.
    /// </summary>
    private void EndShell(SeenDialog d)
    {
        lock (_sync)
        {
            _cancelled = d;
            _log.Warn($"Dialog \"{d.Title}\" did not close; ending the shell (PID {d.Pid}).");
            var (ended, error) = _shell is null ? (false, "no shell process") : _ops.Terminate(_shell);
            _ended = ended;
            _terminationError = ended ? null : error;
            _gaveUp = true;
            if (!ended) _log.Warn($"The shell (PID {d.Pid}) could not be ended{(error is null ? "" : $": {error}")}; trying to cancel the blocked call. 'iecode shells kill' ends it.");
        }
    }

    /// <summary>
    /// The fallback when the shell could not be ended: a COM call blocked on the dialog is cancelled from here (call
    /// cancellation of the thread that made it), so the command fails with the dialog's text instead of waiting forever. Repeated
    /// every few seconds, since the cancel only hits a call that is in flight.
    /// </summary>
    private void CancelBlockedCall()
    {
        if (!_gaveUp || _ended || _callerThread == 0 || DateTime.UtcNow - _lastCancelCall < CancelCallEvery) return;
        _lastCancelCall = DateTime.UtcNow;
        var hr = _ops.CancelCall(_callerThread);
        _log.Detail($"Cancelling the blocked call of thread {_callerThread}: 0x{hr:X8}");
    }

    private static readonly TimeSpan CancelCallEvery = TimeSpan.FromSeconds(3);

    private WindowSnapshot? Snapshot(IntPtr h)
    {
        GetWindowThreadProcessId(h, out var pid);
        if (_pid is { } own && (int)pid != own) return null;
        var title = Title(h);
        if (_pid is null)
        {
            // without an owned shell only the known titles of verified helpers matter; no other window is read further
            if (_isHelper is null || !DialogPolicy.KnownTitles.Contains(title, StringComparer.Ordinal)) return null;
            if (!IsVerifiedHelper((int)pid)) return null;
        }
        var cls = ClassOf(h);
        var owner = GetWindow(h, GW_OWNER);
        var visible = IsWindowVisible(h);
        var ownerDisabled = owner != IntPtr.Zero && !IsWindowEnabled(owner);
        var (text, progress) = cls == DialogPolicy.DialogClass && visible ? Children(h) : ("", false);
        return new WindowSnapshot(h, (int)pid, cls, title, text, visible, ownerDisabled, progress);
    }

    private readonly HashSet<int> _refused = [];

    /// <summary>The helper check runs once per refused process, so an unrelated program's window does not cost a lookup every poll.</summary>
    private bool IsVerifiedHelper(int pid)
    {
        if (_refused.Contains(pid)) return false;
        if (_isHelper!(pid)) return true;
        _refused.Add(pid);
        _log.Detail($"Dialog with a known title in PID {pid} is not a TwinCAT helper; left alone.");
        return false;
    }

    /// <summary>Re-checks that the handle is still the same window (handles are reused) and posts; a failed post is logged, not retried.</summary>
    private bool Post(SeenDialog d, uint msg, IntPtr wParam)
    {
        if (!IsWindow(d.Handle)) return false;
        GetWindowThreadProcessId(d.Handle, out var pid);
        if ((int)pid != d.Pid || ClassOf(d.Handle) != d.ClassName) return false;
        if (PostMessage(d.Handle, msg, wParam, IntPtr.Zero)) return true;
        _log.Detail($"Posting to dialog \"{d.Title}\" failed (Win32 error {Marshal.GetLastWin32Error()}).");
        return false;
    }

    /// <summary>
    /// The texts of the static controls of a dialog (the message of a message box), read with WM_GETTEXT, and whether
    /// it has a progress bar (a progress window of a running operation).
    /// </summary>
    private static (string Text, bool Progress) Children(IntPtr dialog)
    {
        var parts = new List<string>();
        var progress = false;
        EnumChildWindows(dialog, (c, _) =>
        {
            var cls = ClassOf(c);
            if (cls.Equals("msctls_progress32", StringComparison.OrdinalIgnoreCase)) progress = true;
            else if (cls.Equals("Static", StringComparison.OrdinalIgnoreCase) && Text(c) is { Length: > 0 } t) parts.Add(t.Trim());
            return true;
        }, IntPtr.Zero);
        return (string.Join(" ", parts), progress);
    }

    /// <summary>Window text by WM_GETTEXT with a timeout, so a hung window does not stop the watcher.</summary>
    private static string Text(IntPtr h)
    {
        if (SendMessageTimeout(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out var len) == IntPtr.Zero) return "";
        var size = (int)Math.Min(len, 4096) + 1;
        var buffer = Marshal.AllocHGlobal(size * 2);
        try
        {
            if (SendMessageTimeout(h, WM_GETTEXT, size, buffer, SMTO_ABORTIFHUNG, 500, out var copied) == IntPtr.Zero) return "";
            return Marshal.PtrToStringUni(buffer, (int)Math.Min(copied, size - 1));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    /// <summary>Caption of a top-level window; GetWindowText reads it without a message, so it is cheap for every window.</summary>
    private static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        return GetWindowText(h, sb, sb.Capacity) > 0 ? sb.ToString() : "";
    }

    private static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        return GetClassName(h, sb, sb.Capacity) > 0 ? sb.ToString() : "";
    }

    public void Dispose()
    {
        _stop.Set();
        if (Thread.CurrentThread != _thread) _thread.Join(TimeSpan.FromSeconds(5));
    }

    private const uint WM_COMMAND = 0x0111;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_GETTEXTLENGTH = 0x000E;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint GW_OWNER = 4;
    private static readonly IntPtr IDOK = 1;
    private static readonly IntPtr IDCANCEL = 2;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out nint result);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}

/// <summary>The process and COM operations the watcher uses on the shell; tests replace them to make ending the shell fail.</summary>
[SupportedOSPlatform("windows")]
internal sealed class ShellOps
{
    /// <summary>Ends the shell and waits for its exit through the same handle; <c>Ended</c> only when the exit was seen.</summary>
    public required Func<Process, (bool Ended, string? Error)> Terminate { get; init; }
    public required Func<uint> CurrentThread { get; init; }
    public required Action EnableCallCancellation { get; init; }
    /// <summary>Cancels the call the thread is blocked in; returns the HRESULT.</summary>
    public required Func<uint, int> CancelCall { get; init; }

    public static readonly ShellOps Real = new()
    {
        Terminate = KillAndWait,
        CurrentThread = GetCurrentThreadId,
        EnableCallCancellation = () => CoEnableCallCancellation(IntPtr.Zero),
        CancelCall = thread => CoCancelCall(thread, 0),
    };

    private static (bool, string?) KillAndWait(Process p)
    {
        try
        {
            p.Kill();
            return p.WaitForExit(TimeSpan.FromSeconds(5)) ? (true, null) : (false, "it did not end within 5 s");
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return (false, e.Message);
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("ole32.dll")]
    private static extern int CoEnableCallCancellation(IntPtr reserved);

    [DllImport("ole32.dll")]
    private static extern int CoCancelCall(uint threadId, uint timeoutSeconds);
}
