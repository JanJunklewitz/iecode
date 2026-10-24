namespace IECode.Core.Tests;

/// <summary>A throwaway copy of the fixtures, so tests can edit files freely.</summary>
public sealed class TempWorkspace : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "iecode-tests-" + Guid.NewGuid().ToString("N")[..8]);

    public TempWorkspace()
    {
        Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures"), Root);
    }

    public string this[string relative] => Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));

    /// <summary>Creates a file (and its folders) with some bytes.</summary>
    public string Touch(string relative, int bytes = 10)
    {
        var p = this[relative];
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllBytes(p, new byte[bytes]);
        return p;
    }

    private static void Copy(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
        foreach (var d in Directory.GetDirectories(from)) Copy(d, Path.Combine(to, Path.GetFileName(d)));
    }

    public void Dispose()
    {
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { }
    }
}
