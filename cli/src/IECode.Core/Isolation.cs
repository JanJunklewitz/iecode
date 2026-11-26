using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace IECode.Core;

/// <summary>A temporary copy of a solution's folder for an isolated build; deleted on dispose unless <see cref="Keep"/> is set.</summary>
public sealed class IsolatedCopy(string sourceRoot, string copyRoot, string solution, int files) : IDisposable
{
    public string SourceRoot { get; } = sourceRoot;
    public string CopyRoot { get; } = copyRoot;
    /// <summary>The solution inside the copy.</summary>
    public string Solution { get; } = solution;
    public int Files { get; } = files;
    private bool keep;

    /// <summary>Keep the copy on dispose. Recorded in its marker: a later run never removes a kept copy.</summary>
    public bool Keep
    {
        get => keep;
        set { keep = value; Isolation.MarkKept(CopyRoot, value); }
    }

    /// <summary>
    /// Deletes the copy, retrying while files are still open (the shell process lives on for a few seconds after
    /// Quit); false when it is still there after <paramref name="wait"/>. A later isolated build of the same repository
    /// removes it once its owner is gone and it is 24 h old.
    /// </summary>
    public bool TryDelete(TimeSpan wait)
    {
        var deadline = DateTime.UtcNow + wait;
        while (true)
        {
            try
            {
                if (Directory.Exists(CopyRoot)) Isolation.DeleteFolder(CopyRoot);
                return true;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                if (DateTime.UtcNow >= deadline) return false;
                Thread.Sleep(250);
            }
        }
    }

    public void Dispose()
    {
        if (!Keep) TryDelete(TimeSpan.FromSeconds(15));
    }
}

/// <summary>
/// Builds in a short temporary copy: generated caches and external resources then change the copy, not the working
/// tree. The folder is copied as it is, ignored and untracked files included (a project needed a git-ignored
/// generated folder); only git data and build output stay behind.
/// </summary>
public static partial class Isolation
{
    public static readonly string[] Excluded = [".git", ".vs", "_CompileInfo", "_Boot"];

    /// <summary>Default parent folder of the copies: %TEMP%\iecode\b.</summary>
    public static string DefaultDir => Path.Combine(Path.GetTempPath(), "iecode", "b");

    private static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>The folder to copy: the git top level of the solution's folder, else the solution's folder.</summary>
    public static string RootOf(string solution)
    {
        var folder = Path.GetDirectoryName(Path.GetFullPath(solution))!;
        try { return Git.Open(folder).Root; }
        catch (IECodeException) { return folder; }
    }

    /// <summary>
    /// The preferred copy folder of one run: <c>&lt;dir&gt;\&lt;hash of the source root&gt;-&lt;pid&gt;</c>. <see cref="Create"/> takes
    /// the first of this name and <c>...-2</c>, <c>...-3</c>, ... that does not exist yet, so the real path may differ.
    /// </summary>
    public static string CopyRootFor(string root, string isolateDir, int pid)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToLowerInvariant())))[..8].ToLowerInvariant();
        return Path.Combine(Path.GetFullPath(isolateDir), $"{hash}-{pid}");
    }

    [GeneratedRegex(@"^Project\(""\{(?<type>[^}]+)\}""\)\s*=\s*""[^""]*""\s*,\s*""(?<path>[^""]+)""", RegexOptions.Multiline)]
    private static partial Regex ProjectLine();

    private const string SolutionFolderType = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

    /// <summary>
    /// References the copy cannot follow: project paths of the .sln (any kind, missing ones too), <c>Include</c> items of
    /// .plcproj files and <c>File</c> / <c>*FilePath</c> attributes of .tsproj, .tspproj and .xti files that leave
    /// <paramref name="root"/>, and every absolute path (inside the copy it would still point at the original).
    /// Each entry is "&lt;file&gt;: &lt;reference&gt;".
    /// </summary>
    public static IReadOnlyList<string> OutsideRoot(string solution, string root)
    {
        root = Path.GetFullPath(root);
        solution = Path.GetFullPath(solution);
        var found = new List<string>();
        var scan = new List<string>();
        var slnDir = Path.GetDirectoryName(solution)!;
        foreach (Match m in ProjectLine().Matches(File.ReadAllText(solution)))
        {
            if (m.Groups["type"].Value.Equals(SolutionFolderType, StringComparison.OrdinalIgnoreCase)) continue;
            var value = m.Groups["path"].Value;
            if (Check(solution, value, slnDir) is { } full && File.Exists(full)) scan.Add(full);
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < scan.Count; i++)
        {
            var file = scan[i];
            if (!seen.Add(file)) continue;
            var ext = Path.GetExtension(file).ToLowerInvariant();
            if (ext is not (".plcproj" or ".tsproj" or ".tspproj" or ".xti")) continue;
            if (ext is ".tsproj" or ".tspproj")
                scan.AddRange(PathLength.ProjectFiles(Path.GetDirectoryName(file)!).Where(f => f.EndsWith(".xti", StringComparison.OrdinalIgnoreCase)));
            XDocument doc;
            try { doc = XDocument.Load(file); }
            catch (Exception e) when (e is System.Xml.XmlException or IOException) { continue; }
            var dir = Path.GetDirectoryName(file)!;
            foreach (var (attr, value) in References(doc, ext))
                if (Check(file, value, dir) is { } full && attr.EndsWith("FilePath", StringComparison.Ordinal) && full.EndsWith(".plcproj", StringComparison.OrdinalIgnoreCase) && File.Exists(full))
                    scan.Add(full);
        }
        return found;

        // the resolved path when it stays inside the root; records it otherwise
        string? Check(string file, string value, string baseDir)
        {
            if (value.Contains("$(", StringComparison.Ordinal)) return null;
            var native = value.Replace('\\', Path.DirectorySeparatorChar);
            var full = Path.GetFullPath(Path.Combine(baseDir, native));
            if (Path.IsPathRooted(native) || !Inside(full, root))
            {
                found.Add($"{Path.GetRelativePath(root, file)}: {value}");
                return null;
            }
            return full;
        }
    }

    private static IEnumerable<(string Attr, string Value)> References(XDocument doc, string ext)
    {
        foreach (var e in doc.Descendants())
        foreach (var a in e.Attributes())
        {
            var name = a.Name.LocalName;
            var isInclude = ext == ".plcproj" && name == "Include"
                // library references name a library, not a file
                && !e.Name.LocalName.EndsWith("Reference", StringComparison.Ordinal) && !e.Name.LocalName.EndsWith("Resolution", StringComparison.Ordinal);
            var isFile = ext != ".plcproj" && (name == "File" || name.EndsWith("FilePath", StringComparison.Ordinal));
            if ((isInclude || isFile) && a.Value.Length > 0) yield return (name, a.Value);
        }
    }

    private static bool Inside(string full, string root) =>
        full.Equals(root, PathComparison) || full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, PathComparison);

    /// <summary>
    /// Copies the solution's root folder (see <see cref="RootOf"/>) into a new folder below <paramref name="isolateDir"/>.
    /// The folder is allocated, never replaced: one that already exists is left alone and the next free name is taken.
    /// </summary>
    public static IsolatedCopy Create(string solution, string isolateDir, int? pid = null)
    {
        solution = Path.GetFullPath(solution);
        var root = RootOf(solution);
        var dir = Path.GetFullPath(isolateDir);
        // junctions and symbolic links hide where a path really is: compare the physical locations
        if (Inside(PhysicalPath(dir), PhysicalPath(root)))
            throw new IECodeException(ExitCodes.Usage, $"The copy folder '{dir}' is inside the folder to copy '{root}'.", "Pass an --isolate-dir outside of it.");

        var id = pid ?? Environment.ProcessId;
        RemoveStaleCopies(root, dir);
        var copyRoot = Allocate(root, dir, id);
        int files;
        try { files = CopyTree(root, copyRoot); }
        catch
        {
            try { DeleteFolder(copyRoot); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            throw;
        }
        // %TEMP% may be an 8.3 short path; XAE reports long ones
        copyRoot = LongPath(copyRoot);
        return new IsolatedCopy(root, copyRoot, Path.Combine(copyRoot, Path.GetRelativePath(root, solution)), files);
    }

    /// <summary>The path with every link or junction on the way resolved; the parts that do not exist yet stay as they are.</summary>
    internal static string PhysicalPath(string path)
    {
        var full = Path.GetFullPath(path);
        var rootPart = Path.GetPathRoot(full)!;
        var current = rootPart;
        foreach (var seg in full[rootPart.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var next = Path.Combine(current, seg);
            FileSystemInfo info = Directory.Exists(next) ? new DirectoryInfo(next) : new FileInfo(next);
            string? target = null;
            try { if (info.Exists) target = info.ResolveLinkTarget(true)?.FullName; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            current = target is null ? next : Path.GetFullPath(target);
        }
        return current;
    }

    /// <summary>
    /// What a copy folder says about itself. Only folders with this file are ever deleted by a later run, so a folder
    /// that merely has a matching name (or was made by something else) is never touched.
    /// </summary>
    internal sealed record Marker(int Pid, long StartTicks, string Root, bool Kept);

    internal const string MarkerName = ".iecode-isolated";

    private static string MarkerPath(string dir) => Path.Combine(dir, MarkerName);

    private static string Format(Marker m) => $"pid={m.Pid}\nstart={m.StartTicks}\nroot={m.Root}\nkept={(m.Kept ? 1 : 0)}\n";

    /// <summary>The marker of a copy folder; null when there is none or it cannot be read.</summary>
    internal static Marker? ReadMarker(string dir)
    {
        try
        {
            var values = File.ReadAllLines(MarkerPath(dir)).Select(l => l.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0], p => p[1]);
            return new Marker(int.Parse(values["pid"], System.Globalization.CultureInfo.InvariantCulture),
                long.Parse(values["start"], System.Globalization.CultureInfo.InvariantCulture), values["root"], values["kept"] == "1");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or KeyNotFoundException or FormatException or ArgumentException) { return null; }
    }

    internal static void WriteMarker(string dir, Marker m) => File.WriteAllText(MarkerPath(dir), Format(m));

    internal static void MarkKept(string dir, bool kept)
    {
        try { if (ReadMarker(dir) is { } m) WriteMarker(dir, m with { Kept = kept }); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Creates the next free <c>&lt;hash&gt;-&lt;pid&gt;[-n]</c> folder; its marker file is created exclusively, which claims it.</summary>
    private static string Allocate(string root, string dir, int pid)
    {
        var preferred = CopyRootFor(root, dir, pid);
        Directory.CreateDirectory(dir);
        long start = 0;
        if (pid == Environment.ProcessId)
            try { start = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks; } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
        var marker = new Marker(pid, start, root, false);
        for (var n = 1; n <= 1000; n++)
        {
            var candidate = n == 1 ? preferred : $"{preferred}-{n}";
            if (Directory.Exists(candidate) || File.Exists(candidate)) continue;
            Directory.CreateDirectory(candidate);
            try { using var s = new FileStream(MarkerPath(candidate), FileMode.CreateNew, FileAccess.Write, FileShare.None); s.Write(Encoding.UTF8.GetBytes(Format(marker))); }
            catch (IOException) when (ReadMarker(candidate) is not null) { continue; }   // another run claimed it first
            return candidate;
        }
        throw new IECodeException(ExitCodes.Failed, $"No free copy folder below '{dir}'.", "Delete old copies there or pass another --isolate-dir.");
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, EntryPoint = "GetLongPathNameW")]
    private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint size);

    /// <summary>The long form of an existing path (Windows 8.3 names expanded); the path itself elsewhere or on failure.</summary>
    internal static string LongPath(string path)
    {
        if (!OperatingSystem.IsWindows()) return path;
        var sb = new StringBuilder(1024);
        var n = GetLongPathName(path, sb, (uint)sb.Capacity);
        return n > 0 && n < sb.Capacity ? sb.ToString() : path;
    }

    /// <summary>
    /// Deletes copies of the same source that carry a marker, are not kept, belong to a process that is gone and are
    /// more than 24 h old. Anything else in the folder (no marker, other source, live owner) is left alone.
    /// </summary>
    private static void RemoveStaleCopies(string root, string dir)
    {
        if (!Directory.Exists(dir)) return;
        var prefix = Path.GetFileName(CopyRootFor(root, dir, 0))[..9];   // "<hash>-"
        foreach (var d in Directory.EnumerateDirectories(dir, prefix + "*"))
        {
            if (ReadMarker(d) is not { Kept: false } m || !m.Root.Equals(root, PathComparison) || OwnerAlive(m)) continue;
            if (Directory.GetLastWriteTimeUtc(d) > DateTime.UtcNow.AddHours(-24)) continue;
            try { DeleteFolder(d); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
    }

    /// <summary>Whether the recorded process still runs: same id and, when recorded, the same start time (ids are reused). Unsure counts as alive.</summary>
    private static bool OwnerAlive(Marker m)
    {
        try
        {
            using var p = Process.GetProcessById(m.Pid);
            if (p.HasExited) return false;
            return m.StartTicks == 0 || Math.Abs(p.StartTime.ToUniversalTime().Ticks - m.StartTicks) <= TimeSpan.FromSeconds(2).Ticks;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return false; }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or NotSupportedException) { return true; }
    }

    private static int CopyTree(string from, string to)
    {
        var options = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        Directory.CreateDirectory(to);
        var count = 0;
        foreach (var f in Directory.EnumerateFiles(from, "*", options))
        {
            // a .git file (worktree, submodule) would make the copy part of the original repository
            if (Excluded.Contains(Path.GetFileName(f), StringComparer.OrdinalIgnoreCase) || Path.GetFileName(f).Equals(MarkerName, StringComparison.OrdinalIgnoreCase)) continue;
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            count++;
        }
        foreach (var d in Directory.EnumerateDirectories(from, "*", options))
            if (!Excluded.Contains(Path.GetFileName(d), StringComparer.OrdinalIgnoreCase))
                count += CopyTree(d, Path.Combine(to, Path.GetFileName(d)));
        return count;
    }

    /// <summary>
    /// The diagnostic with paths inside the copy pointing at the same file in the source: the file (in any spelling:
    /// '/' or '..' segments) and the copy's folder in the message text.
    /// </summary>
    public static Diagnostic MapBack(Diagnostic d, IsolatedCopy copy)
    {
        var root = copy.CopyRoot.TrimEnd(Path.DirectorySeparatorChar);
        if (d.File is { } f)
        {
            string full;
            try { full = Path.GetFullPath(f.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar)); }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { full = f; }
            if (Inside(full, root))
                d = d with { File = Path.Combine(copy.SourceRoot, full[root.Length..].TrimStart(Path.DirectorySeparatorChar)) };
        }
        return d.Message.Contains(root, PathComparison)
            ? d with { Message = d.Message.Replace(root, copy.SourceRoot.TrimEnd(Path.DirectorySeparatorChar), PathComparison) }
            : d;
    }

    /// <summary>
    /// Copies the .tmc files the build wrote (newer than <paramref name="sinceUtc"/>) to the same place in the source, so
    /// <c>ads symbols</c> and the extension see them; returns the written source paths.
    /// </summary>
    public static IReadOnlyList<string> CopyTmcBack(IsolatedCopy copy, DateTime sinceUtc)
    {
        var written = new List<string>();
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var f in Directory.EnumerateFiles(copy.CopyRoot, "*.tmc", options))
        {
            // file times tick more coarsely than the clock; copied files keep their old times anyway
            if (File.GetLastWriteTimeUtc(f) < sinceUtc.AddSeconds(-2)) continue;
            var target = Path.Combine(copy.SourceRoot, Path.GetRelativePath(copy.CopyRoot, f));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(f, target, overwrite: true);
            written.Add(target);
        }
        written.Sort(StringComparer.Ordinal);
        return written;
    }

    /// <summary>Deletes a folder, read-only files included.</summary>
    internal static void DeleteFolder(string dir)
    {
        foreach (var f in Directory.EnumerateFiles(dir, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            File.SetAttributes(f, FileAttributes.Normal);
        Directory.Delete(dir, recursive: true);
    }
}
