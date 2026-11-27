namespace IECode.Core.Tests;

public sealed class StagedExportTests : IDisposable
{
    private readonly string _dist = Path.Combine(Path.GetTempPath(), "iecode-export-" + Guid.NewGuid().ToString("N")[..8], "dist");
    public void Dispose() { try { Directory.Delete(Path.GetDirectoryName(_dist)!, true); } catch (IOException) { } }

    private string Final => Path.Combine(_dist, "Tc3_Lib_1.0.0.0.library");

    [Fact]
    public void EveryExportGetsItsOwnPathWithTheFinalName()
    {
        using var a = StagedExport.Begin(Final);
        using var b = StagedExport.Begin(Final);
        Assert.NotEqual(a.Path, b.Path);
        Assert.Equal("Tc3_Lib_1.0.0.0.library", Path.GetFileName(a.Path));
        Assert.Equal(Path.GetFullPath(Final), a.FinalFile);
    }

    [Fact]
    public void AnotherExportOfTheSameNameCannotChangeWhatThisOneHolds()
    {
        using var first = StagedExport.Begin(Final);
        File.WriteAllText(first.Path, "first");
        using var second = StagedExport.Begin(Final);
        File.WriteAllText(second.Path, "second");
        second.Publish();                               // the other run finishes and publishes while the first one waits for the repository lock
        Assert.Equal("first", File.ReadAllText(first.Path));   // what the first installs
        first.Publish();
        Assert.Equal("first", File.ReadAllText(Final));
    }

    [Fact]
    public void PublishReplacesAnExistingFinalFileAndDisposeCleansUp()
    {
        Directory.CreateDirectory(_dist);
        File.WriteAllText(Final, "old");
        string folder;
        using (var e = StagedExport.Begin(Final))
        {
            folder = Path.GetDirectoryName(e.Path)!;
            File.WriteAllText(e.Path, "new");
            Assert.Equal("old", File.ReadAllText(Final));   // not visible before it is complete and published
            e.Publish();
        }
        Assert.Equal("new", File.ReadAllText(Final));
        Assert.False(Directory.Exists(folder));
        Assert.Equal([Final], Directory.EnumerateFileSystemEntries(_dist));
    }

    [Fact]
    public void AFailedPublishKeepsTheOnlyCopyAndNamesIt()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "only Windows refuses to replace a file that is open without sharing");
        Directory.CreateDirectory(_dist);
        File.WriteAllText(Final, "old");
        string staged;
        using (var e = StagedExport.Begin(Final))
        {
            staged = e.Path;
            File.WriteAllText(staged, "new");
            using var reader = new FileStream(Final, FileMode.Open, FileAccess.Read, FileShare.None);
            var error = Assert.Throws<IECodeException>(e.Publish);
            Assert.Equal(ExitCodes.LibraryFailed, error.ExitCode);
            Assert.Contains(staged, error.Message);
        }
        Assert.Equal("new", File.ReadAllText(staged));   // Dispose left it
        Assert.Equal("old", File.ReadAllText(Final));
    }

    [Fact]
    public void WithoutPublishTheFinalFileStaysAsItWasAndNothingIsLeft()
    {
        Directory.CreateDirectory(_dist);
        File.WriteAllText(Final, "old");
        using (var e = StagedExport.Begin(Final)) File.WriteAllText(e.Path, "half");
        Assert.Equal("old", File.ReadAllText(Final));
        Assert.Equal([Final], Directory.EnumerateFileSystemEntries(_dist));
    }
}
