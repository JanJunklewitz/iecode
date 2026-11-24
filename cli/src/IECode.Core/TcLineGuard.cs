namespace IECode.Core;

/// <summary>The TwinCAT version to start the shell with, and a warning to print when the choice was not the obvious one.</summary>
public sealed record TcChoice(TwinCatVersion Request, string? Note);

/// <summary>
/// Decides the version for <c>--tc auto</c> so that a project is never moved to another TwinCAT line without being
/// told: the 4024 shell cannot open a project once 4026 has saved it. An explicit <c>--tc</c> is never second-guessed.
/// </summary>
public static class TcLineGuard
{
    /// <summary>
    /// A shell reused for several solutions is replaced when the line changes, for a command that saves also when the
    /// exact build changes, and after a dialog made it fail (a cancelled operation or an ended shell must not fail the
    /// next solution with the same dialog).
    /// </summary>
    public static bool NeedsNewShell(TwinCatVersion? open, TwinCatVersion request, bool saves, bool shellFailed) =>
        open is not { } o || shellFailed || request.Line != o.Line || (saves && request != o);

    private const string Hint = "Pass --tc <version>, e.g. --tc 4024 (VS Code: setting iecode.tcVersion, command \"IECode: Select TwinCAT Version…\").";

    /// <param name="savedStamps">The <c>TcVersion</c> of each TwinCAT project of the solution (null when it has none).</param>
    /// <param name="installedBuilds">Builds from <see cref="TwinCatInstall.Builds"/>; empty when unknown (the shell confirms later).</param>
    /// <param name="saves">The command writes project files; only then does a line change stop it, otherwise it warns.</param>
    public static TcChoice Choose(TwinCatVersion requested, IReadOnlyList<string?> savedStamps, IReadOnlyList<string> installedBuilds, bool saves)
    {
        if (!requested.IsAuto) return new(requested, null);

        var stamps = savedStamps.Select(TryParse).OfType<TwinCatVersion>().ToList();
        var installed = installedBuilds.Select(TryParse).OfType<TwinCatVersion>()
            .OrderByDescending(v => v.Build).ThenByDescending(v => v.Revision ?? -1).ToList();
        var installedLines = installed.Select(v => v.Line!.Value).Distinct().Order().ToList();

        var stampedLines = stamps.Select(v => v.Line!.Value).Distinct().Order().ToList();
        string? note = null;
        if (stampedLines.Count > 1)
        {
            var lines = string.Join(" and ", stampedLines);
            if (saves)
                throw new IECodeException(ExitCodes.Usage,
                    $"The projects of this solution were saved with different TwinCAT lines ({lines}); --tc auto does not pick one for a command that saves.", Hint);
            note = $"The projects were saved with different TwinCAT lines ({lines}); opening with the first one. This command does not save.";
        }

        if (installed.Count == 0)
            return new(stamps.FirstOrDefault() ?? TwinCatVersion.Auto, note);

        if (stamps.Count == 0)
        {
            if (installedLines.Count == 1) return new(installed[0], null);
            var lines = string.Join(" and ", installedLines);
            if (saves)
                throw new IECodeException(ExitCodes.Usage,
                    $"The projects carry no TwinCAT version and {lines} are installed; --tc auto would pick one and save the projects with it.", Hint);
            return new(installed[0], $"The projects carry no TwinCAT version; using {installed[0]}, the newest installed. Pass --tc to choose.");
        }

        var stamp = stamps[0];
        if (installed.Any(v => v.Matches(stamp.ToString()) && v.Revision == stamp.Revision))
            return new(stamp, note);
        if (installed.FirstOrDefault(v => v.Line == stamp.Line) is { } sameLine)
            return new(sameLine, Join(note, $"TwinCAT {stamp} is not installed; using {sameLine} of the same line."));
        if (saves)
            throw new IECodeException(ExitCodes.VersionNotInstalled,
                $"The solution was saved with TwinCAT {stamp}; line {stamp.Line} is not installed, and --tc auto does not move it to another line.",
                $"Installed: {string.Join(", ", installed.Select(v => v.ToString()).Reverse())}. {Hint}");
        return new(installed[0], Join(note, $"The solution was saved with TwinCAT {stamp}, which is not installed; using {installed[0]}. This command does not save."));
    }

    private static string Join(string? a, string b) => a is null ? b : a + " " + b;

    private static TwinCatVersion? TryParse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { var v = TwinCatVersion.Parse(text); return v.IsAuto ? null : v; }
        catch (IECodeException) { return null; }
    }
}

/// <summary>What TwinCAT has installed on this machine, read from the file system (no shell start).</summary>
public static class TwinCatInstall
{
    /// <summary>
    /// Installed builds such as 3.1.4024.66, oldest first: the <c>Components\Plc\Build_&lt;build&gt;</c> folders with a
    /// RepTool (the rule <c>RepTool.Find</c> uses). A Visual Studio ProgID alone is no TwinCAT line. Empty when the
    /// folder is missing (older installations without per-build folders).
    /// </summary>
    public static IReadOnlyList<string> Builds(string? twinCatDir)
    {
        if (twinCatDir is null) return [];
        var plc = Path.Combine(twinCatDir, "Components", "Plc");
        if (!Directory.Exists(plc)) return [];
        return Directory.EnumerateDirectories(plc, "Build_*")
            .Where(d => File.Exists(Path.Combine(d, "Common", "RepTool.exe")))
            .Select(d => Path.GetFileName(d)["Build_".Length..])
            .Select(b => { try { return TwinCatVersion.Parse(b); } catch (IECodeException) { return null; } })
            .OfType<TwinCatVersion>()
            .Where(v => v.Revision is not null)
            .OrderBy(v => v.Build).ThenBy(v => v.Revision)
            .Select(v => v.ToString())
            .ToList();
    }
}
