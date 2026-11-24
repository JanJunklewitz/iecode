using System.Diagnostics;

namespace IECode.Core.Tests;

/// <summary>A temporary git repository with one committed file.</summary>
public sealed class TempRepo : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public string Root => _ws["repo"];
    public string this[string relative] => Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));

    public static TempRepo WithCommittedFile(string name, string content)
    {
        var r = new TempRepo();
        Directory.CreateDirectory(r.Root);
        r.Git("init", "-q");
        r.Git("config", "user.email", "test@example.com");
        r.Git("config", "user.name", "test");
        r.Git("config", "core.autocrlf", "false");
        File.WriteAllText(r[name], content);
        r.Git("add", "-A");
        r.Git("commit", "-q", "-m", "init");
        return r;
    }

    public void Git(params string[] args)
    {
        var psi = new ProcessStartInfo("git") { WorkingDirectory = Root, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        p.StandardOutput.ReadToEnd();
        var err = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new InvalidOperationException($"git {string.Join(' ', args)}: {err}");
    }

    public void Dispose() => _ws.Dispose();
}

public class WorkingTreeSnapshotTests
{
    [Fact] public void NotARepositoryGivesNull()
    {
        using var ws = new TempWorkspace();
        Directory.CreateDirectory(ws["plain"]);
        // the temp folder itself may sit inside a repository on a developer machine; a fresh folder with a .git file
        // that points nowhere is not a repository either way
        File.WriteAllText(ws["plain/.git"], "gitdir: does-not-exist");
        Assert.Null(WorkingTreeSnapshot.Take(ws["plain"]));
    }

    [Fact] public void NoGitGivesNull()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        Git.Executable = Path.Combine(repo.Root, "no-such-git.exe");
        try { Assert.Null(WorkingTreeSnapshot.Take(repo.Root)); }
        finally { Git.Executable = null; }
    }

    [Fact] public void ReportsNewAndModifiedFiles()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        var before = WorkingTreeSnapshot.Take(repo.Root)!;
        File.WriteAllText(repo["a.TcPOU"], "y");
        File.WriteAllText(repo["b.sln"], "z");
        Assert.Equal(["a.TcPOU", "b.sln"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
    }

    [Fact] public void FileDirtyBeforeAndTouchedAgainIsReported()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        File.WriteAllText(repo["a.TcPOU"], "y");
        var before = WorkingTreeSnapshot.Take(repo.Root)!;
        var time = File.GetLastWriteTimeUtc(repo["a.TcPOU"]);
        File.WriteAllText(repo["a.TcPOU"], "z");                  // same length
        File.SetLastWriteTimeUtc(repo["a.TcPOU"], time);           // same time: only the content tells
        Assert.Equal(["a.TcPOU"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
    }

    [Fact] public void FileRevertedByTheBuildIsReported()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        File.WriteAllText(repo["a.TcPOU"], "y");
        var before = WorkingTreeSnapshot.Take(repo.Root)!;
        File.WriteAllText(repo["a.TcPOU"], "x");
        Assert.Equal(["a.TcPOU"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
    }

    [Fact] public void RenameReportsBothPaths()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        var before = WorkingTreeSnapshot.Take(repo.Root)!;
        repo.Git("mv", "a.TcPOU", "c.TcPOU");
        Assert.Equal(["a.TcPOU", "c.TcPOU"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
    }

    [Fact] public void UnchangedTreeGivesEmptyList()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        File.WriteAllText(repo["dirty.TcPOU"], "d");
        var before = WorkingTreeSnapshot.Take(repo.Root)!;
        Assert.Empty(WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
    }

    [Fact] public void SubfolderSnapshotSeesOnlyItsFolder()
    {
        using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
        Directory.CreateDirectory(repo["sln"]);
        var before = WorkingTreeSnapshot.Take(repo["sln"])!;
        File.WriteAllText(repo["sln/b.sln"], "z");
        File.WriteAllText(repo["a.TcPOU"], "outside");
        Assert.Equal(["sln/b.sln"], WorkingTreeSnapshot.Take(repo["sln"])!.ChangedSince(before));
    }
}
