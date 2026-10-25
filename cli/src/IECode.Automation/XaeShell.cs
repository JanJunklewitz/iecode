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

        var shell = new XaeShell(log, filter, options, progId, dte);
        shell.Configure();
        log.Detail($"Shell ready after {sw.Elapsed.TotalSeconds:0.0} s");
        return shell;
    }

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
    public IReadOnlyList<string> InstalledVersions()
    {
        var rm = RemoteManager();
        return ComCall.Items(ComCall.Retry(() => (object)rm.Versions)).Select(v => (string)v.ToString()).ToList();
    }

    /// <summary>Selects the TwinCAT version used for the following operations. Must run before opening the solution.</summary>
    public void SelectVersion(TwinCatVersion request)
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

    public string? ActiveUser()
    {
        try { var um = UserManagement(); return ComCall.Retry(() => (string?)um.ActiveUser); }
        catch (IECodeException) { return null; }
    }

    public void SelectUserDb(string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full)) throw new IECodeException(ExitCodes.NotFound, $"User database '{path}' not found.");
        var um = UserManagement();
        try { ComCall.Retry(() => { um.SelectUserDB(full); }); }
        catch (COMException e) { throw new IECodeException(ExitCodes.UserManagementFailed, $"Selecting user database failed: {e.Message}", inner: e); }
        _log.Step($"User database: {Path.GetFileName(full)}");
    }

    public void Login(string user, string password)
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

    public void OpenSolution(string path)
    {
        var full = Path.GetFullPath(path);
        _log.Step($"Opening {Path.GetFileName(full)}…");
        _solution = ComCall.Retry(() => (object)Dte.Solution);
        ComCall.Retry(() => { Solution.Open(full); });
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(5);
        while (!ComCall.Retry(() => (bool)Solution.IsOpen))
        {
            if (DateTime.UtcNow > deadline) throw new IECodeException(ExitCodes.Timeout, $"Opening '{full}' did not finish.");
            Thread.Sleep(250);
        }
        SolutionPath = full;
        WaitUntilIdle();
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
    public void SaveAll()
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
        try
        {
            _log.Detail("Closing shell…");
            ComCall.Retry(() => { Dte.Quit(); }, attempts: 5);
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
            _filter.Dispose();
        }
    }

    // vsBuildState
    private const int BuildStateInProgress = 2;
    private const int BuildStateDone = 3;
}
