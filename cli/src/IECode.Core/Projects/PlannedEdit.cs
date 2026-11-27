namespace IECode.Core.Projects;

/// <summary>
/// The result of editing one .plcproj in memory: the bytes it had when planned, the bytes it should get, and the changes.
/// Writing is two steps so a failing write never leaves a half-written project: <see cref="Stage"/> writes the new bytes
/// to a temporary file next to the project, <see cref="Commit"/> replaces the project with it in one step, but only when
/// the project still has the bytes it had when it was planned.
/// </summary>
public sealed record PlannedEdit(string Path, byte[] Original, byte[] Updated, IReadOnlyList<ReferenceChange> Changes)
{
    /// <summary>Writes <see cref="Updated"/> to a new temporary file in the project's folder and flushes it to disk; returns its path.</summary>
    public string Stage()
    {
        var temp = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Path)!, $".{System.IO.Path.GetFileName(Path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            file.Write(Updated);
            file.Flush(flushToDisk: true);
        }
        catch { Discard(temp); throw; }
        return temp;
    }

    /// <summary>
    /// Replaces the project with the staged file. Refuses when the project changed since it was planned (somebody saved
    /// it in XAE meanwhile) instead of overwriting that change. The staged file is consumed; on a failure it stays for
    /// <see cref="Discard"/>. Between the check and the replace a very short window remains, as for any editor.
    /// </summary>
    public void Commit(string staged)
    {
        if (!File.ReadAllBytes(Path).AsSpan().SequenceEqual(Original))
            throw new IECodeException(ExitCodes.Failed, $"'{Path}' changed since it was read; it was not overwritten.", "Run the command again.");
        File.Replace(staged, Path, null);
    }

    /// <summary>Deletes a staged file that is not needed any more.</summary>
    public static void Discard(string staged)
    {
        try { File.Delete(staged); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
