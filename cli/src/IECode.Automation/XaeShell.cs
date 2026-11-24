using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation;

/// <summary>How to start the TwinCAT XAE shell.</summary>
public sealed record ShellOptions(
    TwinCatVersion Version,
    string? ProgId = null,
    bool Visible = false,
    bool ShowUi = false,
    TimeSpan? Timeout = null);

/// <summary>
/// One running TwinCAT XAE shell (TcXaeShell or Visual Studio), driven through EnvDTE and the
/// TwinCAT Automation Interface with COM late binding. No interop assemblies are needed: the
/// components installed with TwinCAT are used. Always dispose to close the shell.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class XaeShell : IDisposable
{
    /// <summary>ProgIDs tried in order when none is given. 4026 ships TcXaeShell64 (VS 2022 based), 4024 the VS 2017 based shell.</summary>
    public static IReadOnlyList<string> CandidateProgIds(TwinCatVersion v) => v.Line switch
    {
        >= 4026 => ["TcXaeShell.DTE.17.0", "VisualStudio.DTE.17.0"],
        4024 => ["TcXaeShell.DTE.15.0", "VisualStudio.DTE.15.0", "VisualStudio.DTE.16.0"],
        _ => ["TcXaeShell.DTE.17.0", "TcXaeShell.DTE.15.0", "VisualStudio.DTE.17.0", "VisualStudio.DTE.16.0", "VisualStudio.DTE.15.0"],
    };

    private readonly Reporter _log;
    private readonly ComMessageFilter _filter;
    private readonly ShellOptions _options;
    private dynamic? _dte;
    private dynamic? _solution;
    private int _processId;
    private bool _openAttempted;

    public string ProgId { get; }
    public string? SolutionPath { get; private set; }
    public string? SelectedVersion { get; private set; }

    private XaeShell(Reporter log, ComMessageFilter filter, ShellOptions options, string progId, object dte)
    {
        _log = log;
        _filter = filter;
        _options = options;
        ProgId = progId;
        _dte = dte;
    }

    /// <summary>Starts a new, hidden shell instance. Call on an STA thread.</summary>
    public static XaeShell Start(ShellOptions options, Reporter log)
    {
        var progIds = options.ProgId is not null ? [options.ProgId] : CandidateProgIds(options.Version);
        var progId = progIds.FirstOrDefault(p => Type.GetTypeFromProgID(p) is not null)
            ?? throw new IECodeException(ExitCodes.NotFound,
                $"No TwinCAT XAE shell found (tried {string.Join(", ", progIds)}).",
                "Install TwinCAT XAE, or pass --prog-id with the DTE ProgID of your shell. Run 'iecode doctor' for details.");

        var filter = ComMessageFilter.Register();
        var sw = Stopwatch.StartNew();
        log.Step($"Starting {progId}{(options.Visible ? "" : " (hidden)")}…");
        object dte;
        Process? process = null;
        using (var gate = StartGate.Enter(log))
        {
            var before = gate is null ? null : ShellPids();
            try
            {
                dte = Activator.CreateInstance(Type.GetTypeFromProgID(progId)!)
                    ?? throw new IECodeException(ExitCodes.Failed, $"Creating {progId} returned nothing.");
            }
            catch (COMException e)
            {
                filter.Dispose();
                throw new IECodeException(ExitCodes.Failed, $"Starting {progId} failed: {e.Message}", inner: e);
            }
            if (before is not null) process = Owned(before, log);
        }

        var shell = new XaeShell(log, filter, options, progId, dte) { _process = process };
        try
        {
            // right after the PID is known: tie the shell to iecode, record it, and watch a dialog while configuring too
            if (process is not null)
            {
                shell.Register();
                shell._watch = DialogWatch.Start(process, options.Visible || options.ShowUi, log);
            }
            // a dialog while configuring fails Start with its text, not with the COM error of the cancelled call
            shell.Watched(shell.Configure);
            shell._processId = shell.ShellProcessId();
        }
        catch { shell.Dispose(); throw; }
        if (process is null) log.Warn("The started XAE shell could not be told apart from other shells: its dialogs are not watched and it is not ended with iecode in this run (details with -v).");
        log.Detail($"Shell ready after {sw.Elapsed.TotalSeconds:0.0} s");
        return shell;
    }

    // ---------------------------------------------------------------- Shell process

    private Process? _process;
    private DialogWatch? _watch;
    private bool _tied;
    private ShellRegistry? _registry;
    private ShellEntry? _entry;

    /// <summary>Puts the owned shell into the kill-on-close job and records it for <c>iecode shells</c>; failures only log.</summary>
    private void Register()
    {
        _tied = JobObject.TryKillOnClose(_process!, _log);
        try
        {
            using var me = Process.GetCurrentProcess();
            var registry = new ShellRegistry(ShellRegistry.DefaultFolder());
            var entry = new ShellEntry(_process!.Id, _process.StartTime.ToUniversalTime(), me.Id, me.StartTime.ToUniversalTime(), ProgId, null);
            registry.Add(entry);
            (_registry, _entry) = (registry, entry);
            _log.Detail($"Shell process {entry.Pid}{(_tied ? " (ends with iecode)" : "")}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _log.Detail($"Shell not recorded for 'iecode shells': {e.Message}");
        }
    }

    private void Record(string? solution)
    {
        if (_registry is null || _entry is null) return;
        try { _registry.Add(_entry = _entry with { Solution = solution }); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { _log.Detail($"Shell record not updated: {e.Message}"); }
    }

    /// <summary>
    /// After Quit: waits up to 30 s for the shell process to end (it still writes its settings), then drops its record.
    /// An entry is removed only once the exit is confirmed.
    /// </summary>
    private void AwaitExit(bool quitReturned)
    {
        if (_process is null) return;
        try
        {
            // a shell that did not take Quit has no settings to write; do not hold a failed run for 30 s
            if (_process.WaitForExit(TimeSpan.FromSeconds(quitReturned ? 30 : 5)))
            {
                try { _registry?.Remove(_process.Id); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { _log.Detail($"Shell record not removed: {e.Message}"); }
            }
            else if (_tied) _log.Detail($"Shell process {_process.Id} still runs 30 s after closing; it ends with iecode.");
            else _log.Warn($"The XAE shell (PID {_process.Id}) still runs 30 s after closing. 'iecode shells kill' ends it.");
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _log.Detail($"Waiting for the shell to end failed: {e.Message}");
        }
    }

    /// <summary>The shell process iecode started, when it could be told apart from other shells; null otherwise (no watch).</summary>
    public int? ProcessId => _process?.Id;

    /// <summary>Title of the dialog the watcher cancelled, if any.</summary>
    public string? BlockingDialog => _watch?.Cancelled?.Title;

    /// <summary>A dialog was cancelled (or the shell ended): every later call fails with it, so a session starts a new shell.</summary>
    public bool DialogFailed => _watch?.Cancelled is not null;

    private static int[] ShellPids() =>
    [
        .. DialogPolicy.ShellProcessNames.SelectMany(Process.GetProcessesByName).Select(p => { using (p) return p.Id; }),
    ];

    /// <summary>The one shell process CreateInstance started, opened now so its handle stays valid; null when it is not exactly one.</summary>
    private static Process? Owned(int[] before, Reporter log)
    {
        var after = ShellPids();
        if (ShellRegistry.Started(before, after) is not { } pid)
        {
            log.Detail($"Could not tell which shell process was started ({after.Except(before).Count()} new); running without dialog watch.");
            return null;
        }
        try
        {
            var p = Process.GetProcessById(pid);
            _ = p.Handle;
            return p;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            log.Detail($"Shell process {pid} not accessible ({e.Message}); running without dialog watch.");
            return null;
        }
    }

    /// <summary>
    /// The named mutex <c>Local\iecode-shell-start</c> around CreateInstance, so two iecode runs starting a shell at the
    /// same time do not take each other's process. Null when it could not be had in time: then nothing is owned.
    /// </summary>
    private sealed class StartGate : IDisposable
    {
        private readonly Mutex _mutex;
        private StartGate(Mutex m) => _mutex = m;

        public static StartGate? Enter(Reporter log)
        {
            Mutex m;
            try { m = new Mutex(false, @"Local\iecode-shell-start"); }
            catch (Exception e) when (e is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException)
            {
                log.Detail($"Shell start lock not available ({e.Message}).");
                return null;
            }
            try
            {
                if (m.WaitOne(TimeSpan.FromMinutes(2))) return new StartGate(m);
            }
            catch (AbandonedMutexException) { return new StartGate(m); }
            log.Detail("Another iecode is still starting a shell; this one is not watched.");
            m.Dispose();
            return null;
        }

        public void Dispose()
        {
            _mutex.ReleaseMutex();
            _mutex.Dispose();
        }
    }

    /// <summary>Throws the dialog failure once the watcher cancelled a dialog of the shell.</summary>
    internal void ThrowIfDialogCancelled()
    {
        if (_watch?.Failure is { } f) throw f;
    }

    /// <summary>
    /// Runs a shell call that can block on a dialog. Once the watcher cancelled a dialog, any error of the call (the COM
    /// error of the cancelled operation, a wrapped one, a timeout) becomes the dialog failure, and so does success.
    /// </summary>
    private T Watched<T>(Func<T> body)
    {
        T result;
        try { result = body(); }
        catch (Exception e) when (_watch?.Failure is { } f && !ReferenceEquals(e, f))
        {
            _log.Detail($"After the dialog: {e.Message}");
            throw f;
        }
        ThrowIfDialogCancelled();
        return result;
    }

    private void Watched(Action body) => Watched<object?>(() => { body(); return null; });

    /// <summary>Name of the Automation Interface settings object (DTE.GetObject), assembled from its parts.</summary>
    private static readonly string SettingsObject = string.Concat("Tc", "Automation", "Settings");

    private dynamic Dte => _dte ?? throw new ObjectDisposedException(nameof(XaeShell));

    private dynamic Solution => _solution ?? throw new InvalidOperationException("No solution is open.");

    private void Configure()
    {
        ComCall.Retry(() =>
        {
            Dte.SuppressUI = !_options.ShowUi;
            Dte.MainWindow.Visible = _options.Visible;
        });
        if (!_options.Visible)
        {
            // TwinCAT's own dialogs (not covered by SuppressUI) are switched off by the silent mode of the
            // Automation Interface settings object.
            try { ComCall.Retry(() => { Dte.GetObject(SettingsObject).SilentMode = true; }); }
            catch (Exception e) { _log.Detail($"Silent mode not available: {e.Message}"); }
        }
    }

    // ---------------------------------------------------------------- TwinCAT version (Remote Manager)

    /// <summary>Versions known to the TwinCAT Remote Manager, e.g. 3.1.4024.62, 3.1.4024.66.</summary>
    public IReadOnlyList<string> InstalledVersions() => Watched(InstalledVersionsCore);

    private IReadOnlyList<string> InstalledVersionsCore()
    {
        var rm = RemoteManager();
        return ComCall.Items(ComCall.Retry(() => (object)rm.Versions)).Select(v => (string)v.ToString()).ToList();
    }

    /// <summary>Selects the TwinCAT version used for the following operations. Must run before opening the solution.</summary>
    public void SelectVersion(TwinCatVersion request) => Watched(() => SelectVersionCore(request));

    private void SelectVersionCore(TwinCatVersion request)
    {
        if (request.IsAuto) return;
        var installed = InstalledVersions();
        var match = request.Resolve(installed)
            ?? throw new IECodeException(ExitCodes.VersionNotInstalled,
                $"TwinCAT {request} is not installed.",
                installed.Count == 0 ? "The Remote Manager reports no versions." : "Installed: " + string.Join(", ", installed));
        var rm = RemoteManager();
        ComCall.Retry(() => { rm.Version = match; });
        SelectedVersion = match;
        _log.TwinCatVersion = match;
        _log.Step($"Using TwinCAT {match} (Remote Manager)");
    }

    private dynamic RemoteManager() =>
        ComCall.Retry(() => (object?)Dte.GetObject("TcRemoteManager"))
        ?? throw new IECodeException(ExitCodes.NotFound, "TwinCAT Remote Manager not available in this shell.",
            "Selecting a TwinCAT version needs the Remote Manager (TwinCAT 4024 and newer).");

    // ---------------------------------------------------------------- User management (TwinCAT 3 Security Management)

    private dynamic UserManagement() =>
        ComCall.Retry(() => (object?)Dte.GetObject("TcUserManagement"))
        ?? throw new IECodeException(ExitCodes.UserManagementFailed, "TwinCAT user management is not available in this shell.",
            "Needs TwinCAT 3 Security Management (TwinCAT 4024.x or newer).");

    public string? ActiveUser() => Watched(ActiveUserCore);

    private string? ActiveUserCore()
    {
        try { var um = UserManagement(); return ComCall.Retry(() => (string?)um.ActiveUser); }
        catch (IECodeException) { return null; }
    }

    public void SelectUserDb(string path) => Watched(() => SelectUserDbCore(path));

    private void SelectUserDbCore(string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full)) throw new IECodeException(ExitCodes.NotFound, $"User database '{path}' not found.");
        var um = UserManagement();
        try { ComCall.Retry(() => { um.SelectUserDB(full); }); }
        catch (COMException e) { throw new IECodeException(ExitCodes.UserManagementFailed, $"Selecting user database failed: {e.Message}", inner: e); }
        _log.Step($"User database: {Path.GetFileName(full)}");
    }

    public void Login(string user, string password) => Watched(() => LoginCore(user, password));

    private void LoginCore(string user, string password)
    {
        var um = UserManagement();
        try { ComCall.Retry(() => { um.LoginUser(user, password); }); }
        catch (COMException e)
        {
            throw new IECodeException(ExitCodes.UserManagementFailed, $"Login of '{user}' failed: {e.Message}",
                "Check user name and password, and that the right user database is selected (--userdb).", e);
        }
        _log.Step($"Logged in as {user}");
    }

    // ---------------------------------------------------------------- Solution

    /// <summary>
    /// Set by a build without saving: the open solution is closed without saving before another one is opened and before
    /// the shell quits, so changes XAE made while loading are not written then.
    /// </summary>
    public bool DiscardChanges { get; set; }

    private void CloseWithoutSaving()
    {
        // an Open that failed half-way can leave a solution loaded although SolutionPath was never set
        if (!DiscardChanges || _solution is null || (SolutionPath is null && !_openAttempted)) return;
        ComCall.Retry(() => { Solution.Close(false); });
        _log.Detail($"Closed {(SolutionPath is null ? "the solution" : Path.GetFileName(SolutionPath))} without saving");
        _openAttempted = false;
        SolutionPath = null;
    }

    public void OpenSolution(string path) => Watched(() => OpenSolutionCore(path));

    private void OpenSolutionCore(string path)
    {
        var full = Path.GetFullPath(path);
        CloseWithoutSaving();
        _log.Step($"Opening {Path.GetFileName(full)}…");
        _solution = ComCall.Retry(() => (object)Dte.Solution);
        _openAttempted = true;
        ComCall.Retry(() => { Solution.Open(full); });
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(5);
        while (!ComCall.Retry(() => (bool)Solution.IsOpen))
        {
            ThrowIfDialogCancelled();
            if (DateTime.UtcNow > deadline) throw new IECodeException(ExitCodes.Timeout, $"Opening '{full}' did not finish.");
            Thread.Sleep(250);
        }
        SolutionPath = full;
        Record(full);
        WaitUntilIdle();
        _loadOutputPending = true;
    }

    /// <summary>TwinCAT projects of the open solution with their System Manager (ITcSysManager).</summary>
    internal IEnumerable<(dynamic Project, dynamic SysManager, string File)> TwinCatProjects(bool includePlcOnly = true)
    {
        foreach (var project in ComCall.Items(ComCall.Retry(() => (object)Solution.Projects)))
        {
            string file;
            try { file = ComCall.Retry(() => (string)project.FullName); }
            catch (Exception) { continue; }
            var isTs = file.EndsWith(".tsproj", StringComparison.OrdinalIgnoreCase);
            var isPlcOnly = file.EndsWith(".tspproj", StringComparison.OrdinalIgnoreCase);
            if (!isTs && !(includePlcOnly && isPlcOnly)) continue;
            object? sysMan = ComCall.Retry(() => (object?)project.Object);
            if (sysMan is null) continue;
            yield return (project, sysMan, file);
        }
    }

    /// <summary>Saves the solution and all TwinCAT projects (picks up pending changes before build/activate).</summary>
    public void SaveAll() => Watched(SaveAllCore);

    private void SaveAllCore()
    {
        ComCall.Retry(() => { Solution.SaveAs((string)Solution.FullName); });
        foreach (var (project, _, file) in TwinCatProjects())
        {
            ComCall.Retry(() => { project.Save(); });
            _log.Detail($"Saved {Path.GetFileName(file)}");
        }
    }

    /// <summary>Waits until the shell reports no running command (status bar animation off and not building).</summary>
    public void WaitUntilIdle(TimeSpan? max = null)
    {
        var deadline = DateTime.UtcNow + (max ?? TimeSpan.FromSeconds(60));
        while (DateTime.UtcNow < deadline)
        {
            ThrowIfDialogCancelled();
            try
            {
                var building = _solution is not null && ComCall.Retry(() => (int)Solution.SolutionBuild.BuildState) == BuildStateInProgress;
                if (!building) return;
            }
            catch (COMException e) when (ComCall.IsBusy(e)) { }
            Thread.Sleep(250);
        }
    }

    private string StatusText()
    {
        try { return ComCall.Retry(() => (string)Dte.StatusBar.Text, attempts: 2); }
        catch (Exception) { return ""; }
    }

    public void Dispose()
    {
        if (_dte is null) return;
        var quitReturned = false;
        try
        {
            // after a give-up the watcher has ended the shell; there is nothing to quit
            if (_watch?.GaveUp != true)
            {
                _log.Detail("Closing shell…");
                var discarded = true;
                try { CloseWithoutSaving(); }
                catch (Exception e)
                {
                    discarded = false;
                    _log.Warn($"Closing the solution without saving failed: {e.Message}");
                }
                // Quit saves a dirty project (spike): after a failed discard it would write what the command promised not to
                if (discarded) { ComCall.Retry(() => { Dte.Quit(); }, attempts: 5); quitReturned = true; }
                else TerminateWithoutSaving();
            }
        }
        catch (Exception e)
        {
            _log.Warn($"Closing the shell failed: {e.Message}");
        }
        finally
        {
            ComCall.Release(_solution);
            ComCall.Release(_dte);
            _solution = null;
            _dte = null;
            AwaitExit(quitReturned);
            // after Quit, so a dialog while closing is still handled; before Runner writes the result
            _watch?.Dispose();
            _process?.Dispose();
            _filter.Dispose();
        }
    }

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /// <summary>The process of the shell this object started (its main window's owner); 0 when it cannot be told.</summary>
    private int ShellProcessId()
    {
        try
        {
            var hwnd = ComCall.Retry(() => (int)Dte.MainWindow.HWnd);
            return GetWindowThreadProcessId(new IntPtr(hwnd), out var pid) != 0 ? (int)pid : 0;
        }
        catch (Exception) { return 0; }
    }

    /// <summary>Ends the shell process without a Quit, which would save; the shell is this object's own, started for one command.</summary>
    private void TerminateWithoutSaving()
    {
        if (_processId == 0) _processId = ShellProcessId();
        if (_processId == 0)
        {
            _log.Warn("The shell was left running: it could not be closed without saving, and a normal exit would save the project. Close it yourself without saving.");
            return;
        }
        try
        {
            using var p = Process.GetProcessById(_processId);
            p.Kill(entireProcessTree: true);
            _log.Warn("The shell was ended without saving because the solution could not be closed without saving.");
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _log.Warn($"The shell could not be ended ({e.Message}); close it yourself without saving.");
        }
    }

    // vsBuildState
    private const int BuildStateInProgress = 2;
    private const int BuildStateDone = 3;
}
