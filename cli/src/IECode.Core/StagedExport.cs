namespace IECode.Core;

/// <summary>
/// A library export that is private to one invocation. XAE writes to <see cref="Path"/>, in a folder only this run uses
/// (beside the final file, so it is on the same volume); the caller checks it is complete, installs that file and then
/// <see cref="Publish"/>es it to the final name. Another invocation that saves the same title and version meanwhile can
/// neither delete nor replace the bytes this one installs, and a reader of the final file never sees it half written.
/// </summary>
public sealed class StagedExport : IDisposable
{
    private readonly string _folder;
    private bool _disposed;

    /// <summary>Where the final file goes.</summary>
    public string FinalFile { get; }

    /// <summary>The private file XAE writes; it has the same name as the final one.</summary>
    public string Path { get; }

    private StagedExport(string finalFile, string folder)
    {
        FinalFile = finalFile;
        _folder = folder;
        Path = System.IO.Path.Combine(folder, System.IO.Path.GetFileName(finalFile));
    }

    /// <summary>Creates the private folder next to <paramref name="finalFile"/> (and the folder of the final file if needed).</summary>
    public static StagedExport Begin(string finalFile)
    {
        var full = System.IO.Path.GetFullPath(finalFile);
        var folder = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(full)!, ".iecode-" + Guid.NewGuid().ToString("N")[..12]);
        Directory.CreateDirectory(folder);
        return new StagedExport(full, folder);
    }

    /// <summary>
    /// Moves the private file over the final name in one step (an existing file is replaced) and returns the final path.
    /// When the move fails (the final file is locked, access is denied) the private file is the only copy, so it is kept:
    /// <see cref="Dispose"/> leaves the folder, and the error names where the file is.
    /// </summary>
    public string Publish()
    {
        try { File.Move(Path, FinalFile, overwrite: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _kept = true;
            throw new IECodeException(ExitCodes.LibraryFailed, $"The library could not be moved to '{FinalFile}': {e.Message} It was kept as '{Path}'.",
                "Close the program that holds the file, then move it to its final name yourself.", e);
        }
        return FinalFile;
    }

    private bool _kept;

    /// <summary>Removes the private folder, with whatever is left in it, unless a failed <see cref="Publish"/> kept it.</summary>
    public void Dispose()
    {
        if (_disposed || _kept) return;
        _disposed = true;
        try { Directory.Delete(_folder, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
