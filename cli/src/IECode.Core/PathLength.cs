namespace IECode.Core;

/// <summary>Long paths make the hidden XAE shell show dialogs nobody can answer; warn before a build starts.</summary>
public static class PathLength
{
    public const int WarnAt = 200;

    /// <summary>Folders never scanned: git data and build output.</summary>
    public static readonly string[] SkippedFolders = [".git", ".vs", "_CompileInfo", "_Boot"];

    private static readonly string[] ProjectExtensions = [".sln", ".tsproj", ".tspproj", ".xti", ".plcproj"];

    /// <summary>A file XAE opens: solution and project files and the Tc* object files (TcPOU, TcDUT, TcVMO, …).</summary>
    public static bool IsProjectFile(string path)
    {
        var ext = Path.GetExtension(path);
        return ProjectExtensions.Contains(ext, StringComparer.OrdinalIgnoreCase) || ext.StartsWith(".Tc", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The longest full path of a project file below <paramref name="root"/>, or null without one; judged by <see cref="Warning"/>.</summary>
    public static string? Longest(string root)
    {
        string? longest = null;
        foreach (var f in ProjectFiles(root))
            if (longest is null || f.Length > longest.Length) longest = f;
        return longest;
    }

    /// <summary>Project files below a folder; skips <see cref="SkippedFolders"/> and does not follow links or junctions.</summary>
    public static IEnumerable<string> ProjectFiles(string root)
    {
        var options = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        var pending = new Stack<string>([Path.GetFullPath(root)]);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            foreach (var f in Directory.EnumerateFiles(dir, "*", options))
                if (IsProjectFile(f)) yield return f;
            foreach (var d in Directory.EnumerateDirectories(dir, "*", options))
                if (!SkippedFolders.Contains(Path.GetFileName(d), StringComparer.OrdinalIgnoreCase)) pending.Push(d);
        }
    }

    /// <summary>
    /// The warning for a long path below <paramref name="root"/> (null below <see cref="WarnAt"/>); suggests <c>--isolate</c> only when the same file in the
    /// copy at <paramref name="copyRoot"/> would be shorter. When <paramref name="isolating"/>, the build runs in that copy:
    /// null unless the path there is still long.
    /// </summary>
    public static string? Warning(string longest, string root, string copyRoot, bool isolating = false)
    {
        var inCopy = longest.Length - root.TrimEnd('\\', '/').Length + copyRoot.TrimEnd('\\', '/').Length;
        if (!isolating && longest.Length < WarnAt) return null;
        const string Risk = "Hidden shells may show dialogs for long paths";
        if (isolating)
            return inCopy < WarnAt ? null : $"Path of {inCopy} characters in the isolated copy (from {longest}). {Risk}; pass a shorter --isolate-dir.";
        return $"Path of {longest.Length} characters: {longest}. {Risk}"
            + (inCopy < longest.Length ? $"; --isolate builds in a copy where it has {inCopy}." : ".");
    }
}
