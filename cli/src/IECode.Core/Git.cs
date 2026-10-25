using System.Diagnostics;

namespace IECode.Core;

/// <summary>Minimal git access through the git command line (for history comparisons).</summary>
public sealed class Git
{
    public string Root { get; }

    private Git(string root) => Root = root;

    /// <summary>Opens the repository that contains a folder.</summary>
    public static Git Open(string folder)
    {
        var top = Run(folder, "rev-parse", "--show-toplevel")
            ?? throw new IECodeException(ExitCodes.NotFound, $"'{folder}' is not in a git repository.", "Comparing with history needs the project in a git repository.");
        return new Git(Path.GetFullPath(top.Trim()));
    }

    /// <summary>Path relative to the repository, with '/' (resolves symlinks such as /var → /private/var on macOS).</summary>
    public string Rel(string path) => Path.GetRelativePath(Real(Root), Real(path)).Replace('\\', '/');

    /// <summary>Resolves symbolic links segment by segment; works for paths that don't exist (any more).</summary>
    private static string Real(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        var current = root;
        foreach (var seg in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var next = Path.Combine(current, seg);
            FileSystemInfo info = Directory.Exists(next) ? new DirectoryInfo(next) : new FileInfo(next);
            current = (info.Exists ? info.ResolveLinkTarget(true)?.FullName : null) ?? next;
        }
        return current;
    }

    /// <summary>File content at a commit, or null if the file didn't exist there.</summary>
    public string? Show(string gitRef, string path) => Run(Root, "show", $"{gitRef}:{Rel(path)}");

    /// <summary>Files below a folder at a commit, relative to that folder.</summary>
    public IReadOnlyList<string> FilesAt(string gitRef, string folder)
    {
        var baseRel = Rel(folder);
        var output = Run(Root, "ls-tree", "-r", "--name-only", gitRef, "--", baseRel is "" or "." ? "." : baseRel)
            ?? throw new IECodeException(ExitCodes.NotFound, $"Git ref '{gitRef}' not found.");
        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(f => baseRel is "" or "." ? f : Path.GetRelativePath(baseRel, f).Replace('\\', '/'))
            .ToList();
    }

    private static string? Run(string cwd, params string[] args)
    {
        var psi = new ProcessStartInfo("git") { WorkingDirectory = cwd, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in args) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi)!;
            var stdout = p.StandardOutput.ReadToEnd();
            p.StandardError.ReadToEnd();
            p.WaitForExit();
            return p.ExitCode == 0 ? stdout : null;
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            throw new IECodeException(ExitCodes.NotFound, "git is not installed or not on PATH.", inner: e);
        }
    }
}
