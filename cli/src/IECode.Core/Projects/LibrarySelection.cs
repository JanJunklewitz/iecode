using System.Text.RegularExpressions;

namespace IECode.Core.Projects;

/// <summary>One library of a <c>lib update</c>; <see cref="Version"/> null = take <c>--to</c>, else the newest installed.</summary>
public sealed record UpdateItem(string Library, string? Version);

/// <summary>Which libraries a library command works on: the <c>lib update</c> request and the repository filters.</summary>
public static class LibrarySelection
{
    private const string BulkHint = "Pass --lib <name>[=<version>] (repeatable), or --vendor <vendor> with --to latest.";

    /// <summary>
    /// The libraries of a <c>lib update</c>: <c>name=version</c> pairs and bare names (a pair together with
    /// <c>--to</c> is a usage error); without <c>--lib</c>, every library of <paramref name="vendor"/> referenced in
    /// <paramref name="projects"/>, each to its newest installed version (independent libraries never get one fixed
    /// version). <c>--from-project</c> takes exactly one bare name.
    /// </summary>
    public static IReadOnlyList<UpdateItem> ParseUpdate(IReadOnlyList<string> libs, string? to, string? vendor,
        IEnumerable<PlcProjectFile> projects, bool fromProject = false)
    {
        if (fromProject && (libs.Count != 1 || libs[0].Contains('=')))
            throw new IECodeException(ExitCodes.Usage, "--from-project takes exactly one --lib without a version.");

        if (libs.Count == 0)
        {
            if (vendor is null) throw new IECodeException(ExitCodes.Usage, "No library selected.", BulkHint);
            if (to is not (null or "latest" or "*"))
                throw new IECodeException(ExitCodes.Usage, $"--vendor without --lib sets each library to its newest installed version (latest) or to * (always newest); --to {to} would pin independent libraries to one version.",
                    "Use --to latest or --to *, or name the libraries with --lib <name>=<version>.");
            var names = projects.SelectMany(p => p.References)
                .Where(r => r.Effective.Vendor.Equals(vendor, StringComparison.OrdinalIgnoreCase))
                .Select(r => r.Effective.Name)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (names.Count == 0) throw new IECodeException(ExitCodes.NotFound, $"No library of vendor '{vendor}' is referenced in these projects.");
            return [.. names.Select(n => new UpdateItem(n, null))];
        }

        var items = new List<UpdateItem>();
        foreach (var lib in libs)
        {
            var eq = lib.IndexOf('=');
            var item = eq < 0 ? new UpdateItem(lib.Trim(), null) : new UpdateItem(lib[..eq].Trim(), lib[(eq + 1)..].Trim());
            if (item.Library.Length == 0 || item.Version is "")
                throw new IECodeException(ExitCodes.Usage, $"'{lib}' is not a library name or <name>=<version>.", BulkHint);
            if (item.Version is not null && to is not null)
                throw new IECodeException(ExitCodes.Usage, $"'{lib}' has a version and --to {to} is given too.", "Use either <name>=<version> or --to, not both.");
            if (items.Any(i => i.Library.Equals(item.Library, StringComparison.OrdinalIgnoreCase)))
                throw new IECodeException(ExitCodes.Usage, $"{item.Library} is given twice.");
            items.Add(item);
        }
        return items;
    }

    /// <summary>
    /// Sets every item (with its resolved version) in every project. All edits of one project are planned together, and
    /// everything is checked first (versions, encrypted projects, files writable, new files staged), so a bad item
    /// changes nothing. Each project is then replaced in one step by its staged file, only if it did not change meanwhile;
    /// when a replacement fails the error names the projects already changed.
    /// </summary>
    /// <param name="beforeReplace">Called with a project's path right before it is replaced (a test seam).</param>
    public static IReadOnlyList<ReferenceChange> ApplyUpdate(IReadOnlyList<UpdateItem> items, IReadOnlyList<PlcProjectFile> projects, string? vendor, bool dryRun,
        Action<string>? beforeReplace = null)
    {
        var pairs = items.Select(i => (i.Library, Resolved(i))).ToList();
        var plans = projects.Select(p => p.PlanEdits(pairs, vendor)).Where(e => e.Changes.Count > 0).ToList();
        var planned = plans.SelectMany(e => e.Changes).ToList();
        if (dryRun || planned.Count == 0) return planned;

        // read-only files cannot be replaced; ask before anything is staged
        foreach (var e in plans)
        {
            try { using var _ = File.Open(e.Path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new IECodeException(ExitCodes.Failed, $"'{e.Path}' cannot be written: {ex.Message}", "Nothing was changed.");
            }
        }

        var staged = new List<(PlannedEdit Edit, string Temp)>();
        try { foreach (var e in plans) staged.Add((e, e.Stage())); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            foreach (var (_, temp) in staged) PlannedEdit.Discard(temp);
            throw new IECodeException(ExitCodes.Failed, $"Staging the new project file failed: {ex.Message}", "Nothing was changed.");
        }

        var done = new List<PlannedEdit>();
        foreach (var (edit, temp) in staged)
        {
            try
            {
                beforeReplace?.Invoke(edit.Path);
                edit.Commit(temp);
                done.Add(edit);
            }
            catch (Exception ex) when (ex is IECodeException or IOException or UnauthorizedAccessException)
            {
                foreach (var (_, rest) in staged) PlannedEdit.Discard(rest);   // the committed ones are gone already
                throw new IECodeException(ExitCodes.Failed,
                    $"Replacing '{edit.Path}' failed after {done.Count} of {staged.Count} project(s): {(ex is IECodeException ie ? ie.Message : ex.Message)} "
                    + (done.Count == 0 ? "Nothing was changed." : "Already changed: " + string.Join(", ", done.Select(d => d.Path)) + "."), inner: ex);
            }
        }
        return [.. done.SelectMany(d => d.Changes)];
    }

    /// <summary>Library name against a pattern: case-insensitive, only <c>*</c> and <c>?</c> are wildcards (a dot is a dot).</summary>
    public static bool NameMatches(string pattern, string name) =>
        Regex.IsMatch(name, "^" + Regex.Escape(pattern).Replace(@"\*", ".*").Replace(@"\?", ".") + "$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>Installed libraries by name pattern, vendor and version; null filters (and version <c>all</c>) match everything.</summary>
    public static IReadOnlyList<InstalledLibrary> Select(IEnumerable<InstalledLibrary> installed, string? namePattern, string? vendor, string? version) =>
    [
        .. installed.Where(i =>
            (namePattern is null || NameMatches(namePattern, i.Name))
            && (vendor is null || i.Vendor.Equals(vendor, StringComparison.OrdinalIgnoreCase))
            // strict: an unreadable version on either side is no match, never "0"
            && (version is null or "all" || (LibraryRepository.TryParseVersion(version, out var want)
                && LibraryRepository.TryParseVersion(i.Version, out var have) && have == want))),
    ];

    /// <summary>
    /// The library names for <c>lib uninstall --all</c>: every library of <paramref name="vendor"/> installed at
    /// <paramref name="version"/>. Needs a vendor and an explicit version (never <c>all</c>, so a slip does not wipe
    /// every version) and no names; matching nothing is exit 3.
    /// </summary>
    /// <remarks>Returns the installed entries: RepTool gets the version as installed (1.3.1.0), not as typed (1.3.1).</remarks>
    public static IReadOnlyList<InstalledLibrary> UninstallAll(IEnumerable<InstalledLibrary> installed, IReadOnlyList<string> names, string? vendor, string version)
    {
        CheckUninstallAll(names, vendor, version);
        var hits = Select(installed, null, vendor, version)
            .DistinctBy(i => (i.Name.ToLowerInvariant(), i.Version))
            .ToList();
        if (hits.Count == 0) throw new IECodeException(ExitCodes.NotFound, $"There is no installed library of vendor {vendor} at version {version}.");
        return hits;
    }

    /// <summary>The usage rules of <see cref="UninstallAll"/>, to check before the repository is read.</summary>
    public static void CheckUninstallAll(IReadOnlyList<string> names, string? vendor, string version)
    {
        if (names.Count > 0) throw new IECodeException(ExitCodes.Usage, "--all takes the names from the library repository; leave out the library names.");
        if (vendor is null) throw new IECodeException(ExitCodes.Usage, "--all needs --vendor.");
        if (version is "all")
            throw new IECodeException(ExitCodes.Usage, "--all needs one --version, not all.", "Remove every version of a library by naming it: iecode lib uninstall <name> --vendor <vendor>.");
        if (!LibraryRepository.TryParseVersion(version, out _))
            throw new IECodeException(ExitCodes.Usage, $"'{version}' is not a library version.", "Use a version like 1.3.1.0.");
    }

    /// <summary>
    /// The one repository a command reads names from: the explicit one, else the only one that exists. With several
    /// (4024 and 4026 on one PC) the caller must choose, since RepTool's profile decides which one it changes.
    /// </summary>
    public static string SingleRepository(string? explicitPath, IReadOnlyList<string> existing) =>
        explicitPath ?? existing.Count switch
        {
            0 => throw new IECodeException(ExitCodes.NotFound, "No library repository found.", "Pass the folder with --repository."),
            1 => existing[0],
            _ => throw new IECodeException(ExitCodes.Usage, "Several library repositories exist: " + string.Join("; ", existing),
                "Choose the one RepTool changes with --repository."),
        };

    /// <summary>
    /// The repository <c>lib uninstall --all</c> reads its names from, and RepTool deletes from. RepTool's profile decides
    /// which repository changes (<see cref="LibraryRepository.ForLine"/>), so that one is scanned; a different
    /// <paramref name="explicitPath"/> is a usage error instead of a list from one repository deleted from another.
    /// Without a known line (the default profile of an old installation) the explicit or only existing repository is taken.
    /// </summary>
    public static string UninstallRepository(int? toolLine, string profile, string? explicitPath, string? twinCatDir, string? programData, IReadOnlyList<string> existing)
    {
        if (toolLine is not { } line) return SingleRepository(explicitPath, existing);
        var target = LibraryRepository.ForLine(line, twinCatDir, programData)
            ?? throw new IECodeException(ExitCodes.NotFound, $"The library repository of TwinCAT {line} is unknown.", "TWINCAT3DIR or the ProgramData folder is not set on this machine.");
        if (explicitPath is not null && !SamePath(explicitPath, target))
            throw new IECodeException(ExitCodes.Usage, $"--repository {explicitPath} is not the repository RepTool changes: its profile '{profile}' (TwinCAT {line}) changes {target}.",
                "Select the RepTool of that repository with --tc or --profile, or leave out --repository.");
        return target;
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)), StringComparison.OrdinalIgnoreCase);

    private static string Resolved(UpdateItem item) =>
        item.Version ?? throw new ArgumentException($"{item.Library} has no resolved version.", nameof(item));
}
