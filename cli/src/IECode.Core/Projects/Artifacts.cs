namespace IECode.Core.Projects;

/// <summary>Generated TwinCAT folders that are safe to delete; TwinCAT recreates them on the next build.</summary>
public static class Artifacts
{
    public static readonly string[] DefaultFolders = ["_CompileInfo"];
    public static readonly string[] AllFolders = ["_CompileInfo", "_Boot"];

    /// <summary>Finds generated folders below <paramref name="root"/>. Never descends into .git.</summary>
    public static IReadOnlyList<string> Find(string root, IReadOnlyCollection<string> folderNames)
    {
        var result = new List<string>();
        var stack = new Stack<string>([Path.GetFullPath(root)]);
        while (stack.Count > 0)
        {
            foreach (var dir in Directory.EnumerateDirectories(stack.Pop()))
            {
                var name = Path.GetFileName(dir);
                if (folderNames.Contains(name, StringComparer.OrdinalIgnoreCase)) result.Add(dir);
                else if (name is not ".git" and not "node_modules") stack.Push(dir);
            }
        }
        result.Sort(StringComparer.OrdinalIgnoreCase);
        return result;
    }

    /// <summary>Size in bytes of a folder (for reporting).</summary>
    public static long Size(string dir) =>
        Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
}
