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

/// <summary>Result line of a Visual Studio build, in English or German XAE.</summary>
public sealed partial record BuildSummary(int Succeeded, int Failed, int UpToDate, int Skipped)
{
    [GeneratedRegex(@"=+\s*(?:Build|Erstellen|Rebuild All|Alles neu erstellen)\s*:\s*(?<ok>\d+)\s*(?:succeeded|erfolgreich)[^\d]*(?<fail>\d+)\s*(?:failed|fehlerhaft)[^\d]*(?<up>\d+)\s*(?:up-to-date|aktuell)[^\d]*(?<skip>\d+)\s*(?:skipped|übersprungen)",
        RegexOptions.IgnoreCase)]
    private static partial Regex Pattern();

    /// <summary>Parses the last summary line in the build output pane, if any.</summary>
    public static BuildSummary? TryParse(string output)
    {
        var m = Pattern().Matches(output).LastOrDefault();
        return m is null ? null : new BuildSummary(
            int.Parse(m.Groups["ok"].Value), int.Parse(m.Groups["fail"].Value),
            int.Parse(m.Groups["up"].Value), int.Parse(m.Groups["skip"].Value));
    }
}
