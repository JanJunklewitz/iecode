using System.Text.RegularExpressions;

namespace IECode.Core;

/// <summary>Follow-up errors of one library (bracket suffix of the message) or one project.</summary>
public sealed record FollowUpGroup(string Key, int Errors);

/// <summary>
/// Diagnostics of one build, sorted for display. <see cref="All"/> is the input with root causes marked and the
/// generic last line turned into <see cref="Severity.Info"/>; <see cref="Errors"/> counts the errors in it.
/// Display only: exit codes come from the raw signals (see <see cref="BuildOutcome"/>).
/// </summary>
public sealed record Triage(
    IReadOnlyList<Diagnostic> All,
    IReadOnlyList<Diagnostic> RootCauses,
    IReadOnlyList<FollowUpGroup> FollowUps,
    bool StaticAnalysisOnly,
    int Errors);

/// <summary>
/// Whether a build or check failed, from the raw signals only: the triage changes what is shown, never the result,
/// so the generic last line still fails a build that has no other error.
/// </summary>
public static class BuildOutcome
{
    public static bool Ok(int failedProjects, IReadOnlyList<Diagnostic> raw, BuildSummary? summary) =>
        failedProjects == 0 && !raw.Any(d => d.Severity == Severity.Error) && (summary?.Failed ?? 0) == 0;

    /// <summary>Exit code of a command that ran several builds: 10 when any of them failed.</summary>
    public static int ExitCode(IEnumerable<bool> buildsOk) => buildsOk.All(ok => ok) ? ExitCodes.Ok : ExitCodes.BuildFailed;
}

/// <summary>
/// Finds the few errors that cause the rest: a missing library makes every user of it fail, and those follow-up
/// errors hide the one library manager line that names the cause.
/// </summary>
public static partial class BuildTriage
{
    // "PLC1.Library Manager: Could not open library …" (Build pane origin kept in the message)
    [GeneratedRegex(@"^[^:\r\n]+\.Library Manager:\s*", RegexOptions.IgnoreCase)]
    private static partial Regex LibraryManagerPrefix();

    // Error List texts carry no origin, so the cause is also found from the text alone
    [GeneratedRegex(@"has not been installed|is not installed|no valid license|\blibrary\b.*could not be found|could not be found.*\blibrary\b",
        RegexOptions.IgnoreCase)]
    private static partial Regex RootCauseText();

    // The last line of every failed TcXaeShell build (4024: "operation could not be completed", 4026: a COM E_FAIL);
    // it says nothing of its own
    [GeneratedRegex(@"^(?:The operation could not be completed|Der Vorgang konnte nicht abgeschlossen werden|Error HRESULT E_FAIL has been returned from a call to a COM component|Beim Aufruf einer COM-Komponente wurde ein HRESULT E_FAIL-Fehler zurückgegeben)",
        RegexOptions.IgnoreCase)]
    private static partial Regex GenericLine();

    // "… 'Tc3_MotorLib.FB_Motor' [tc3_axislib, 1.0.0.0 (example)]": the library the error was found in
    [GeneratedRegex(@"\[(?<k>[^\]]+)\]\s*$")]
    private static partial Regex LibrarySuffix();

    public static bool IsRootCause(Diagnostic d) =>
        d.Severity == Severity.Error && (LibraryManagerPrefix().IsMatch(d.Message) || RootCauseText().IsMatch(d.Message));

    public static bool IsGenericLine(Diagnostic d) => d.Severity == Severity.Error && GenericLine().IsMatch(d.Message);

    public static Triage Classify(IReadOnlyList<Diagnostic> diagnostics)
    {
        var all = new List<Diagnostic>(diagnostics.Count);
        var roots = new List<Diagnostic>();
        var groups = new Dictionary<string, int>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var d in diagnostics)
        {
            if (IsGenericLine(d)) { all.Add(d with { Severity = Severity.Info }); continue; }
            if (IsRootCause(d))
            {
                var root = d with { RootCause = true };
                all.Add(root);
                roots.Add(root);
                continue;
            }
            all.Add(d);
            if (d.Severity != Severity.Error) continue;
            var key = LibrarySuffix().Match(d.Message) is { Success: true } m ? m.Groups["k"].Value.Trim()
                : d.Project is { Length: > 0 } p ? $"project {p}" : "other";
            if (!groups.TryAdd(key, 1)) groups[key]++;
            else order.Add(key);
        }
        var errors = all.Where(d => d.Severity == Severity.Error).ToList();

        // TcXaeShell 4024 reports a library that is not installed only as a library manager warning ("has not been
        // added to the Library Manager, or no valid license could be found"); in a failed build with no error that
        // names a cause, that warning is the cause.
        if (roots.Count == 0 && errors.Count > 0)
            for (var i = 0; i < all.Count; i++)
                if (all[i] is { Severity: Severity.Warning } w && LibraryManagerPrefix().IsMatch(w.Message) && RootCauseText().IsMatch(w.Message))
                    roots.Add(all[i] = w with { RootCause = true });

        return new Triage(all, roots, [.. order.Select(k => new FollowUpGroup(k, groups[k]))],
            errors.Count > 0 && errors.All(d => d.Code?.StartsWith("SA", StringComparison.Ordinal) == true), errors.Count);
    }

    /// <summary>
    /// Adds the library manager lines of the Build pane to the Error List items: the lines written while the
    /// project opens can be missing from the Error List. One line per (project, message without the origin prefix).
    /// </summary>
    public static IReadOnlyList<Diagnostic> Merge(IReadOnlyList<Diagnostic> errorList, IReadOnlyList<Diagnostic> pane)
    {
        var seen = new HashSet<(string, string)>();
        var merged = new List<Diagnostic>(errorList.Count);
        foreach (var d in errorList.Concat(pane.Where(d => LibraryManagerPrefix().IsMatch(d.Message))))
            if (seen.Add(((d.Project ?? "").ToUpperInvariant(), LibraryManagerPrefix().Replace(d.Message, "").Trim())))
                merged.Add(d);
        return merged;
    }
}
