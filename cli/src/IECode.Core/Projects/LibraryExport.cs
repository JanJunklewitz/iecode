namespace IECode.Core.Projects;

/// <summary>One PLC project to save as a library, and where.</summary>
public sealed record LibraryExportItem(Unit Unit, string File);

/// <summary>
/// Plans <c>iecode lib save-all</c>: every PLC project of a workspace that has a solution, in build order
/// (so with <c>--install</c> a library is installed before the projects that use it are saved).
/// Library projects are named <c>&lt;Title&gt;_&lt;Version&gt;</c>, others by their PLC name.
/// </summary>
public static class LibraryExport
{
    public static IReadOnlyList<LibraryExportItem> Plan(Workspace w, bool compiled, string? outDir, bool librariesOnly, string dist = "dist")
    {
        var ext = compiled ? ".compiled-library" : ".library";
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var items = new List<LibraryExportItem>();
        foreach (var u in w.BuildOrder().Select(id => w[id]))
        {
            if (u.Solution is null || (librariesOnly && !u.Plc.IsLibrary)) continue;
            var dir = Path.GetFullPath(outDir ?? Path.Combine(Path.GetDirectoryName(u.Solution.Path)!, dist));
            var baseName = u.Plc.IsLibrary ? $"{u.Plc.Title}_{u.Plc.ProjectVersion}" : u.Plc.Name;
            var file = Path.Combine(dir, baseName + ext);
            // Same name twice into one folder (copies of a solution, PLC1 in several solutions): prefix the solution.
            if (!taken.Add(file))
            {
                file = Path.Combine(dir, $"{u.Solution.Name}_{baseName}{ext}");
                for (var i = 2; !taken.Add(file); i++) file = Path.Combine(dir, $"{u.Solution.Name}_{baseName}_{i}{ext}");
            }
            items.Add(new LibraryExportItem(u, file));
        }
        return items;
    }
}
