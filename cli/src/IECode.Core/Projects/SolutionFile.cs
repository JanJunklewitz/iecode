using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace IECode.Core.Projects;

/// <summary>A Visual Studio solution and the TwinCAT / PLC projects it contains, read from the files only.</summary>
public sealed partial class SolutionFile
{
    public required string Path { get; init; }
    public required IReadOnlyList<TwinCatProjectFile> TwinCatProjects { get; init; }

    public string Name => System.IO.Path.GetFileNameWithoutExtension(Path);
    public IEnumerable<PlcProjectFile> PlcProjects => TwinCatProjects.SelectMany(p => p.PlcProjects);

    [GeneratedRegex(@"^Project\(""\{[^}]+\}""\)\s*=\s*""(?<name>[^""]*)""\s*,\s*""(?<path>[^""]+)""", RegexOptions.Multiline)]
    private static partial Regex ProjectLine();

    private static readonly string[] TwinCatExtensions = [".tsproj", ".tspproj"];

    public static SolutionFile Load(string path)
    {
        path = System.IO.Path.GetFullPath(path);
        if (!File.Exists(path))
            throw new IECodeException(ExitCodes.NotFound, $"Solution '{path}' not found.");
        var dir = System.IO.Path.GetDirectoryName(path)!;
        var projects = ProjectLine().Matches(File.ReadAllText(path))
            .Select(m => m.Groups["path"].Value.Replace('\\', System.IO.Path.DirectorySeparatorChar))
            .Where(p => TwinCatExtensions.Contains(System.IO.Path.GetExtension(p), StringComparer.OrdinalIgnoreCase))
            .Select(p => System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, p)))
            .Where(File.Exists)
            .Select(TwinCatProjectFile.Load)
            .ToList();
        return new SolutionFile { Path = path, TwinCatProjects = projects };
    }

    /// <summary>
    /// Resolves what the user passed: a .sln file, or a folder with exactly one .sln (searched two levels deep).
    /// </summary>
    public static string Find(string? pathOrFolder)
    {
        var p = System.IO.Path.GetFullPath(string.IsNullOrEmpty(pathOrFolder) ? "." : pathOrFolder);
        if (File.Exists(p)) return p;
        if (!Directory.Exists(p))
            throw new IECodeException(ExitCodes.NotFound, $"'{pathOrFolder}' does not exist.");
        var found = Directory.EnumerateFiles(p, "*.sln", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 2 })
            .Where(f => !f.Contains($"{System.IO.Path.DirectorySeparatorChar}_", StringComparison.Ordinal))
            .ToList();
        return found.Count switch
        {
            1 => found[0],
            0 => throw new IECodeException(ExitCodes.NotFound, $"No .sln found in '{p}'."),
            _ => throw new IECodeException(ExitCodes.Usage, $"Several .sln files found in '{p}'.",
                "Pass the solution file explicitly:\n  " + string.Join("\n  ", found)),
        };
    }
}

/// <summary>A TwinCAT project (<c>.tsproj</c>) or PLC-only project (<c>.tspproj</c>).</summary>
public sealed class TwinCatProjectFile
{
    public required string Path { get; init; }
    public required IReadOnlyList<PlcProjectFile> PlcProjects { get; init; }

    /// <summary>TwinCAT version the project was last saved with, e.g. 3.1.4024.66 (attribute TcVersion), if present.</summary>
    public string? TcVersion { get; init; }

    public string Name => System.IO.Path.GetFileNameWithoutExtension(Path);
    public bool IsPlcOnly => Path.EndsWith(".tspproj", StringComparison.OrdinalIgnoreCase);

    public static TwinCatProjectFile Load(string path)
    {
        var dir = System.IO.Path.GetDirectoryName(path)!;
        var doc = XDocument.Load(path);
        var plc = doc.Descendants()
            .Where(e => e.Name.LocalName == "Project" && e.Attribute("PrjFilePath") is not null)
            .Select(e => System.IO.Path.GetFullPath(System.IO.Path.Combine(dir,
                e.Attribute("PrjFilePath")!.Value.Replace('\\', System.IO.Path.DirectorySeparatorChar))))
            .Where(File.Exists)
            .Distinct()
            .Select(PlcProjectFile.Load)
            .ToList();
        return new TwinCatProjectFile
        {
            Path = path,
            PlcProjects = plc,
            TcVersion = doc.Root?.Attribute("TcVersion")?.Value,
        };
    }
}
