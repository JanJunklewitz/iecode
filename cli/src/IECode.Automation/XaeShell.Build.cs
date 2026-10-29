using System.Diagnostics;
using System.Runtime.InteropServices;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation;

/// <summary>Outcome of building one target platform.</summary>
public sealed record BuildResult(string Platform, bool Ok, int FailedProjects, int Errors, int Warnings, BuildSummary? Summary, double Seconds);

public sealed partial class XaeShell
{
    /// <summary>Target platforms the TwinCAT projects support, e.g. "TwinCAT RT (x64)".</summary>
    public IReadOnlyList<string> TargetPlatforms() =>
        TwinCatProjects(includePlcOnly: true)
            .SelectMany(p => ComCall.Items(ComCall.Retry(() => (object)p.SysManager.ConfigurationManager.TargetPlatforms)))
            .Select(x => (string)x.ToString())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>Sets the active target platform on every TwinCAT project that supports it.</summary>
    public void SelectPlatform(string platform)
    {
        var applied = 0;
        foreach (var (_, sysMan, _) in TwinCatProjects())
        {
            var cfg = ComCall.Retry(() => (object)sysMan.ConfigurationManager);
            dynamic c = cfg;
            var supported = ComCall.Items(ComCall.Retry(() => (object)c.TargetPlatforms)).Select(x => (string)x.ToString());
            if (!supported.Contains(platform, StringComparer.OrdinalIgnoreCase)) continue;
            if (!string.Equals(ComCall.Retry(() => (string)c.ActiveTargetPlatform), platform, StringComparison.OrdinalIgnoreCase))
                ComCall.Retry(() => { c.ActiveTargetPlatform = platform; });
            applied++;
        }
        if (applied == 0)
            throw new IECodeException(ExitCodes.Usage, $"No project supports platform '{platform}'.",
                "Available: " + string.Join(", ", TargetPlatforms()));
    }

    public void Clean()
    {
        _log.Step("Cleaning…");
        ComCall.Retry(() => { Solution.SolutionBuild.Clean(true); });
    }

    /// <summary>Activates a solution configuration such as Debug or Release.</summary>
    public void SelectConfiguration(string name)
    {
        var configs = ComCall.Items(ComCall.Retry(() => (object)Solution.SolutionBuild.SolutionConfigurations)).ToList();
        var match = configs.FirstOrDefault(c => string.Equals((string)c.Name, name, StringComparison.OrdinalIgnoreCase));
        if (match is null)
            throw new IECodeException(ExitCodes.Usage, $"Solution configuration '{name}' not found.",
                "Available: " + string.Join(", ", configs.Select(c => (string)c.Name).Distinct()));
        dynamic m = match;
        ComCall.Retry(() => { m.Activate(); });
    }

    /// <summary>Builds the solution for the current (or given) platform and collects the compiler messages.</summary>
    public BuildResult Build(string? platform)
    {
        if (platform is not null) SelectPlatform(platform);
        var active = platform ?? TwinCatProjects()
            .Select(p => ComCall.Retry(() => (string)p.SysManager.ConfigurationManager.ActiveTargetPlatform))
            .FirstOrDefault() ?? "default";

        SaveAll();
        ClearErrorList();
        _log.Step($"Building {Path.GetFileName(SolutionPath)} · {active}");
        var sw = Stopwatch.StartNew();
        var timeout = _options.Timeout ?? TimeSpan.FromMinutes(30);

        var build = ComCall.Retry(() => (object)Solution.SolutionBuild);
        dynamic b = build;
        ComCall.Retry(() => { b.Build(false); });
        while (ComCall.Retry(() => (int)b.BuildState) != BuildStateDone)
        {
            if (sw.Elapsed > timeout)
                throw new IECodeException(ExitCodes.Timeout, $"Build did not finish within {timeout.TotalMinutes:0} min.", "Raise the limit with --timeout <seconds>.");
            _log.Status(StatusText());
            Thread.Sleep(300);
        }
        _log.ClearStatus();

        var failedProjects = ComCall.Retry(() => (int)b.LastBuildInfo);
        var output = ReadOutputPane("Build");
        var diags = ReadErrorList() ?? BuildOutput.Parse(output);
        foreach (var d in diags) _log.Add(d);
        var summary = BuildSummary.TryParse(output);
        var errors = diags.Count(d => d.Severity == Severity.Error);
        var ok = failedProjects == 0 && errors == 0 && (summary?.Failed ?? 0) == 0;
        return new BuildResult(active, ok, failedProjects, errors, diags.Count(d => d.Severity == Severity.Warning), summary, sw.Elapsed.TotalSeconds);
    }

    /// <summary>Runs "Check all objects" on every PLC project (faster than a full build, no output files).</summary>
    public (int Errors, int Warnings) CheckAllObjects()
    {
        ClearErrorList();
        foreach (var plc in PlcProjects())
        {
            _log.Step($"Checking {plc.Name}…");
            dynamic nested = plc.Nested;
            try { ComCall.Retry(() => { nested.CheckAllObjects(); }); }
            catch (Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
            {
                throw new IECodeException(ExitCodes.Failed, "This TwinCAT version doesn't support 'Check all objects' through the Automation Interface.", "Use 'iecode build' instead.");
            }
        }
        WaitUntilIdle();
        var diags = ReadErrorList() ?? BuildOutput.Parse(ReadOutputPane("Build"));
        foreach (var d in diags) _log.Add(d);
        return (diags.Count(d => d.Severity == Severity.Error), diags.Count(d => d.Severity == Severity.Warning));
    }

    // EnvDTE.Constants.vsWindowKindErrorList / vsWindowKindOutput
    private const string ErrorListWindow = "{D78612C7-9962-4B83-95D9-268046DAD23A}";
    private const string OutputWindow = "{34E76E81-EE4A-11D0-AE2E-00A0C90FFFC3}";

    /// <summary>
    /// The automation object of a tool window (ErrorList, OutputWindow). Goes through _DTE.Windows because
    /// late binding sees the shell's _DTE type info, which has no DTE2.ToolWindows.
    /// </summary>
    private dynamic ToolWindow(string kind) => ComCall.Retry(() => (object)Dte.Windows.Item(kind).Object);

    /// <summary>The Error List entries, or null if the shell doesn't expose them (then the caller parses the Build pane).</summary>
    private List<Diagnostic>? ReadErrorList()
    {
        var list = new List<Diagnostic>();
        object items;
        try
        {
            var errorList = ToolWindow(ErrorListWindow);
            items = ComCall.Retry(() => (object)errorList.ErrorItems);
        }
        catch (Exception e)
        {
            _log.Detail($"Error list not readable ({e.Message}); using the Build output instead");
            return null;
        }

        foreach (var item in ComCall.Items(items))
        {
            var (code, text) = BuildOutput.SplitCode(ComCall.Retry(() => (string)item.Description));
            int level = ComCall.Retry(() => (int)item.ErrorLevel);
            string? file = ComCall.Retry(() => (string?)item.FileName);
            int line = ComCall.Retry(() => (int)item.Line);
            int col = ComCall.Retry(() => (int)item.Column);
            list.Add(new Diagnostic(
                level switch { 4 => Severity.Error, 2 => Severity.Warning, _ => Severity.Info }, // vsBuildErrorLevel High/Medium/Low
                text,
                code,
                string.IsNullOrEmpty(file) ? null : file,
                ComCall.Retry(() => (string?)item.Project),
                line > 0 ? line : null,
                col > 0 ? col : null));
        }
        return list;
    }

    private bool _loadOutputPending;

    /// <summary>
    /// Clears the Build pane before a build or check, except for the first one after <see cref="OpenSolution"/>:
    /// what opening wrote there (e.g. libraries that can't be loaded) is reported with that build. Reading the pane
    /// before the first build instead fails in TcXaeShell 15 and leaves the build hanging.
    /// </summary>
    private void ClearErrorList()
    {
        if (_loadOutputPending)
        {
            _loadOutputPending = false;
            return;
        }
        try
        {
            var output = ToolWindow(OutputWindow);
            ComCall.Retry(() => { output.OutputWindowPanes.Item("Build").Clear(); }, attempts: 3);
        }
        catch (Exception) { /* pane appears only after the first build */ }
    }

    private string ReadOutputPane(string name)
    {
        try
        {
            var output = ToolWindow(OutputWindow);
            var doc = ComCall.Retry(() => (object)output.OutputWindowPanes.Item(name).TextDocument);
            dynamic d = doc;
            var start = ComCall.Retry(() => (object)d.StartPoint.CreateEditPoint());
            dynamic s = start;
            return ComCall.Retry(() => (string)s.GetText(d.EndPoint));
        }
        catch (Exception e) when (e is COMException or ArgumentException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            _log.Detail($"Output pane '{name}' not readable: {e.Message}");
            return "";
        }
    }
}
