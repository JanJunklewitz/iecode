using System.Text.RegularExpressions;

namespace IECode.Core;

public enum Severity { Error, Warning, Info }

/// <summary>A compiler message, mapped to the TwinCAT object file it belongs to.</summary>
public sealed record Diagnostic(
    Severity Severity,
    string Message,
    string? Code = null,
    string? File = null,
    string? Project = null,
    int? Line = null,
    int? Column = null);

/// <summary>
/// Compiler errors and warnings from the text of the XAE "Build" output pane. Used when the Error List can't be
/// read through automation (TcXaeShell 15 throws from ErrorList.ErrorItems).
/// </summary>
public static partial class BuildOutput
{
    // "C:\…\FB_A.TcPOU;FB_A\M_Run(4) : error: …", "FB_A(46) : error: …", "Plc.Library Manager : warning: …"
    [GeneratedRegex(@"^(?<origin>.+?)\s+:\s+(?<sev>error|warning|fehler|warnung)\s*:\s*(?<msg>.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex Located();

    // "Error: The operation could not be completed."
    [GeneratedRegex(@"^(?<sev>error|warning|fehler|warnung)\s*:\s*(?<msg>.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex Bare();

    [GeneratedRegex(@"^-+\s*(?:Build started|Erstellen gestartet)\s*:\s*(?:Project|Projekt)\s*:\s*(?<project>[^,]+),", RegexOptions.IgnoreCase)]
    private static partial Regex ProjectStart();

    [GeneratedRegex(@"^(?<file>[A-Za-z]:\\[^;(]+?)(?:;(?<obj>[^(]+))?(?:\((?<line>\d+)\))?$")]
    private static partial Regex FileOrigin();

    [GeneratedRegex(@"^(?<obj>.+?)(?:\((?<line>\d+)\))?$")]
    private static partial Regex ObjectOrigin();

    // "PLC1.Library Manager": printed while the libraries load, before the project's "Build started" line
    [GeneratedRegex(@"^(?<project>.+)\.Library Manager$", RegexOptions.IgnoreCase)]
    private static partial Regex LibraryManager();

    [GeneratedRegex(@"^(?<code>[A-Z]{1,3}\d{3,5})\s*:\s*")]
    private static partial Regex CodePrefix();

    /// <summary>Splits a leading compiler code ("C0077: …") off a message.</summary>
    public static (string? Code, string Message) SplitCode(string text)
    {
        var m = CodePrefix().Match(text);
        return m.Success ? (m.Groups["code"].Value, text[m.Length..]) : (null, text);
    }

    public static List<Diagnostic> Parse(string output)
    {
        var list = new List<Diagnostic>();
        string? project = null;
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (ProjectStart().Match(line) is { Success: true } p) { project = p.Groups["project"].Value.Trim(); continue; }

            string? file = null, origin = null, owner = project;
            int? lineNo = null;
            Match m;
            if ((m = Located().Match(line)).Success)
            {
                var o = m.Groups["origin"].Value.Trim();
                if (LibraryManager().Match(o) is { Success: true } lm) owner = lm.Groups["project"].Value;
                var at = FileOrigin().Match(o);
                if (!at.Success) at = ObjectOrigin().Match(o);
                file = at.Groups["file"].Success ? at.Groups["file"].Value : null;
                origin = at.Groups["obj"].Success ? at.Groups["obj"].Value : null;
                lineNo = at.Groups["line"].Success ? int.Parse(at.Groups["line"].Value) : null;
            }
            else if (!(m = Bare().Match(line)).Success) continue;

            var (code, text) = SplitCode(m.Groups["msg"].Value.Trim());
            var severity = m.Groups["sev"].Value.ToLowerInvariant() is "error" or "fehler" ? Severity.Error : Severity.Warning;
            list.Add(new Diagnostic(severity, origin is null ? text : $"{origin}: {text}", code, file, owner, lineNo));
        }
        return list;
    }
}

/// <summary>Result line of a Visual Studio build, in English or German XAE.</summary>
public sealed partial record BuildSummary(int Succeeded, int Failed, int UpToDate, int Skipped)
{
    [GeneratedRegex(@"=+\s*(?:Build|Erstellen|Rebuild All|Alles neu erstellen)\s*:\s*(?<ok>\d+)\s*(?:succeeded|erfolgreich)[^\d]*(?<fail>\d+)\s*(?:failed|fehlerhaft)[^\d]*(?<up>\d+)\s*(?:up-to-date|aktuell)[^\d]*(?<skip>\d+)\s*(?:skipped|übersprungen)",
        RegexOptions.IgnoreCase)]
    private static partial Regex Pattern();

    // TcXaeShell 15 (VS 2017) counts succeeded and up-to-date together: "Build: 1 succeeded or up-to-date, 2 failed, 0 skipped"
    [GeneratedRegex(@"=+\s*(?:Build|Erstellen|Rebuild All|Alles neu erstellen)\s*:\s*(?<ok>\d+)\s*(?:succeeded or up-to-date|erfolgreich oder aktuell)[^\d]*(?<fail>\d+)\s*(?:failed|fehlerhaft)[^\d]*(?<skip>\d+)\s*(?:skipped|übersprungen)",
        RegexOptions.IgnoreCase)]
    private static partial Regex CombinedPattern();

    /// <summary>Parses the last summary line in the build output pane, if any.</summary>
    public static BuildSummary? TryParse(string output)
    {
        var m = Pattern().Matches(output).Concat(CombinedPattern().Matches(output)).MaxBy(x => x.Index);
        return m is null ? null : new BuildSummary(
            int.Parse(m.Groups["ok"].Value), int.Parse(m.Groups["fail"].Value),
            m.Groups["up"].Success ? int.Parse(m.Groups["up"].Value) : 0, int.Parse(m.Groups["skip"].Value));
    }
}
