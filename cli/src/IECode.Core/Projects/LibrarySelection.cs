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
            if (to is not (null or "latest"))
                throw new IECodeException(ExitCodes.Usage, $"--vendor without --lib sets each library to its newest installed version; --to {to} would pin independent libraries to one version.",
                    "Use --to latest, or name the libraries with --lib <name>=<version>.");
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
    /// Sets every item (with its resolved version) in every project. Everything is checked first (versions, encrypted
    /// projects, files writable), so a bad item changes nothing; an I/O error during the writes reports what was
    /// already changed.
    /// </summary>
    public static IReadOnlyList<ReferenceChange> ApplyUpdate(IReadOnlyList<UpdateItem> items, IReadOnlyList<PlcProjectFile> projects, string? vendor, bool dryRun)
    {
        var planned = new List<ReferenceChange>();
        var touched = new List<PlcProjectFile>();
        foreach (var item in items)
        foreach (var p in projects)
        {
            var c = p.SetLibraryVersion(item.Library, Resolved(item), vendor, dryRun: true);
            if (c.Count > 0 && !touched.Contains(p)) touched.Add(p);
            planned.AddRange(c);
        }
        if (dryRun || planned.Count == 0) return planned;

        foreach (var p in touched)
        {
            try { using var _ = File.Open(p.Path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw new IECodeException(ExitCodes.Failed, $"'{p.Path}' cannot be written: {e.Message}", "Nothing was changed.");
            }
        }

        var done = new List<ReferenceChange>();
        foreach (var item in items)
        foreach (var p in touched)
        {
            try { done.AddRange(p.SetLibraryVersion(item.Library, Resolved(item), vendor)); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw new IECodeException(ExitCodes.Failed, $"Writing '{p.Path}' failed after {done.Count} of {planned.Count} change(s): {e.Message}",
                    done.Count == 0 ? "Nothing was changed." : "Already changed: " + string.Join(", ", done.Select(c => $"{c.Project} {c.Library} → {c.To}")));
            }
        }
        return done;
    }

    private static string Resolved(UpdateItem item) =>
        item.Version ?? throw new ArgumentException($"{item.Library} has no resolved version.", nameof(item));
}
