namespace IECode.Core.Tests;

public sealed class IsolationTests : IDisposable
{
    private readonly TempWorkspace ws = new();
    private string TempBase => ws["isolated"];

    const string SolutionFolder = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

    static string Sln(params string[] projects) =>
        "Microsoft Visual Studio Solution File, Format Version 12.00\n" + string.Concat(projects.Select((p, i) =>
            $"Project(\"{{B1E792BE-AA5F-4E3C-8C82-674BF9C0715B}}\") = \"P{i}\", \"{p}\", \"{{00000000-0000-0000-0000-00000000000{i}}}\"\nEndProject\n"));

    const string Plcproj = """
        <Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
          <ItemGroup>
            <Compile Include="POUs\MAIN.TcPOU" />
            <PlaceholderReference Include="Tc2_Standard" />
          </ItemGroup>
        </Project>
        """;

    public IsolationTests()
    {
        File.WriteAllText(ws.Touch("src/sln/Machine.sln"), Sln(@"PLC1\PLC1.plcproj"));
        File.WriteAllText(ws.Touch("src/sln/PLC1/PLC1.plcproj"), Plcproj);
        ws.Touch("src/sln/PLC1/POUs/MAIN.TcPOU");
        ws.Touch("src/sln/PLC1/Gen/Generated.TcGVL");       // git-ignored generated file in the real case
        ws.Touch("src/sln/.vs/x");
        ws.Touch("src/sln/PLC1/_CompileInfo/y");
        ws.Touch("src/sln/PLC1/_Boot/z");
    }

    public void Dispose() => ws.Dispose();

    [Fact] public void CopiesIgnoredFilesButNotBuildOutput()
    {
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.True(File.Exists(Path.Combine(copy.CopyRoot, "PLC1", "Gen", "Generated.TcGVL")));
        Assert.True(File.Exists(Path.Combine(copy.CopyRoot, "PLC1", "POUs", "MAIN.TcPOU")));
        Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, ".vs")));
        Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, "PLC1", "_CompileInfo")));
        Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, "PLC1", "_Boot")));
        Assert.Equal(Path.Combine(copy.CopyRoot, "Machine.sln"), copy.Solution);
        Assert.Equal(4, copy.Files);
    }

    [Fact] public void GitFileIsNotCopied()
    {
        // a worktree or submodule has a .git file; in the copy it would point at the original repository
        File.WriteAllText(ws["src/sln/.git"], "gitdir: does-not-exist");
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.False(File.Exists(Path.Combine(copy.CopyRoot, ".git")));
    }

    [Fact] public void FailedCopyLeavesNothingBehind()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "only Windows locks open files against reading");
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        using (new FileStream(ws["src/sln/PLC1/POUs/MAIN.TcPOU"], FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.ThrowsAny<IOException>(() => Isolation.Create(ws["src/sln/Machine.sln"], TempBase));
        Assert.False(Directory.Exists(Isolation.CopyRootFor(root, TempBase, Environment.ProcessId)));
    }

    [Fact] public void MapsOtherSpellingsAndMessageTextBack()
    {
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        var slashes = new Diagnostic(Severity.Error, "x", File: copy.CopyRoot.Replace('\\', '/') + "/PLC1/POUs/FB_A.TcPOU");
        Assert.Equal(ws["src/sln/PLC1/POUs/FB_A.TcPOU"], Isolation.MapBack(slashes, copy).File);
        var dots = new Diagnostic(Severity.Error, "x", File: Path.Combine(copy.CopyRoot, "PLC1", "..", "PLC1", "POUs", "FB_A.TcPOU"));
        Assert.Equal(ws["src/sln/PLC1/POUs/FB_A.TcPOU"], Isolation.MapBack(dots, copy).File);
        var text = new Diagnostic(Severity.Error, $"Cannot open '{Path.Combine(copy.CopyRoot, "PLC1", "x.TcPOU")}'");
        Assert.Equal($"Cannot open '{ws["src/sln/PLC1/x.TcPOU"]}'", Isolation.MapBack(text, copy).Message);
    }

    [Fact] public void CopyIsDeletedOnDispose()
    {
        var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        copy.Dispose();
        Assert.False(Directory.Exists(copy.CopyRoot));
    }

    [Fact] public void CopyInUseIsReportedNotThrown()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "only Windows keeps open files from being deleted");
        var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        using (File.OpenRead(Path.Combine(copy.CopyRoot, "Machine.sln")))
            Assert.False(copy.TryDelete(TimeSpan.FromMilliseconds(300)));
        Assert.True(copy.TryDelete(TimeSpan.FromSeconds(5)));
        Assert.False(Directory.Exists(copy.CopyRoot));
    }

    [Fact] public void KeptCopyStays()
    {
        var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        copy.Keep = true;
        copy.Dispose();
        Assert.True(Directory.Exists(copy.CopyRoot));
    }

    [Fact] public void MapsDiagnosticPathsBack()
    {
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        var d = new Diagnostic(Severity.Error, "x", File: Path.Combine(copy.CopyRoot, "PLC1", "POUs", "FB_A.TcPOU"));
        Assert.Equal(ws["src/sln/PLC1/POUs/FB_A.TcPOU"], Isolation.MapBack(d, copy).File);
        var outside = new Diagnostic(Severity.Error, "x", File: ws["elsewhere/FB_B.TcPOU"]);
        Assert.Equal(outside, Isolation.MapBack(outside, copy));
        Assert.Equal("x", Isolation.MapBack(new Diagnostic(Severity.Error, "x"), copy).Message);
    }

    [Fact] public void MapsDiagnosticPathsBackInAnyCaseOnWindows()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "Windows paths ignore case");
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        var d = new Diagnostic(Severity.Error, "x", File: Path.Combine(copy.CopyRoot.ToUpperInvariant(), "PLC1", "POUs", "FB_A.TcPOU"));
        Assert.Equal(ws["src/sln/PLC1/POUs/FB_A.TcPOU"], Isolation.MapBack(d, copy).File, ignoreCase: true);
    }

    [Fact] public void InsideRootIsFine() =>
        Assert.Empty(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));

    [Fact] public void ReferenceOutsideRootIsReported()
    {
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"PLC1\PLC1.plcproj", @"..\shared\Lib\Lib.tsproj"));
        var found = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains(@"..\shared\Lib\Lib.tsproj", found);
    }

    [Fact] public void AbsolutePathIntoTheSourceIsReported()
    {
        // inside the copy it would still point at the original
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(ws["src/sln/PLC1/PLC1.plcproj"]));
        Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
    }

    [Fact] public void NonTwinCatProjectOutsideRootIsReported()
    {
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"PLC1\PLC1.plcproj", @"..\tools\Tool.csproj"));
        Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
    }

    [Fact] public void ProjectTypeThatCouldWriteAnywhereIsReportedEvenInsideTheRoot()
    {
        // a helper project in the tree can build to an absolute OutputPath: the copy is no sandbox
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"PLC1\PLC1.plcproj", @"Tool\Tool.csproj"));
        ws.Touch("src/sln/Tool/Tool.csproj");
        var found = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains("Tool.csproj", found);
        Assert.Contains("not supported", found);
    }

    [Fact] public void UnresolvablePathIsReportedNotSkipped()
    {
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"$(Base)\PLC1.plcproj"));
        var inSln = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains("$(Base)", inSln);

        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"PLC1\PLC1.plcproj"));
        File.WriteAllText(ws["src/sln/PLC1/PLC1.plcproj"], Plcproj.Replace(@"POUs\MAIN.TcPOU", @"$(SolutionDir)MAIN.TcPOU"));
        var inProject = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains("$(SolutionDir)", inProject);
    }

    [Fact] public void SolutionFoldersAreNoPaths()
    {
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"PLC1\PLC1.plcproj") +
            $"Project(\"{{{SolutionFolder}}}\") = \"..\", \"..\", \"{{00000000-0000-0000-0000-0000000000AA}}\"\nEndProject\n");
        Assert.Empty(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
    }

    [Fact] public void PlcprojItemOutsideRootIsReported()
    {
        File.WriteAllText(ws["src/sln/PLC1/PLC1.plcproj"], Plcproj.Replace(@"POUs\MAIN.TcPOU", @"..\..\shared\MAIN.TcPOU"));
        var found = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains("PLC1.plcproj", found);
    }

    [Fact] public void XtiPrjFilePathOutsideRootIsReported()
    {
        File.WriteAllText(ws["src/sln/Machine.sln"], Sln(@"TwinCAT\TwinCAT.tsproj"));
        File.WriteAllText(ws.Touch("src/sln/TwinCAT/TwinCAT.tsproj"),
            """<TcSmProject TcVersion="3.1.4024.66"><Project><Plc><Project File="PLC1.xti"/></Plc></Project></TcSmProject>""");
        File.WriteAllText(ws.Touch("src/sln/TwinCAT/_Config/PLC/PLC1.xti"),
            """<TcSmItem><Project Name="PLC1" PrjFilePath="..\..\..\..\shared\PLC1\PLC1.plcproj" TmcFilePath="..\..\..\PLC1\PLC1.tmc"/></TcSmItem>""");
        var found = Assert.Single(Isolation.OutsideRoot(ws["src/sln/Machine.sln"], ws["src/sln"]));
        Assert.Contains("PLC1.xti", found);
    }

    [Fact] public void IsolateDirInsideTheSourceIsRefused()
    {
        var e = Assert.Throws<IECodeException>(() => Isolation.Create(ws["src/sln/Machine.sln"], ws["src/sln/tmp"]));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
    }

    private static Isolation.Marker Owner(string root, int pid, long startTicks = 0, bool kept = false) => new(pid, startTicks, root, kept);

    [Fact] public void ConcurrentCopiesDoNotCollide()
    {
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        var live = Isolation.CopyRootFor(root, TempBase, Environment.ProcessId);
        var deadOld = Isolation.CopyRootFor(root, TempBase, 999_991);
        var deadNew = Isolation.CopyRootFor(root, TempBase, 999_992);
        foreach (var d in new[] { live, deadOld, deadNew }) Directory.CreateDirectory(d);
        Isolation.WriteMarker(live, Owner(root, Environment.ProcessId));
        Isolation.WriteMarker(deadOld, Owner(root, 999_991));
        Isolation.WriteMarker(deadNew, Owner(root, 999_992));
        Directory.SetLastWriteTimeUtc(deadOld, DateTime.UtcNow.AddDays(-2));

        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase, pid: 999_993);
        Assert.EndsWith("-999993", copy.CopyRoot);
        Assert.True(Directory.Exists(live));        // another run still uses it
        Assert.False(Directory.Exists(deadOld));    // its run ended long ago
        Assert.True(Directory.Exists(deadNew));     // ended recently: may still be looked at
    }

    [Fact] public void ExistingFolderAtTheCopyPathIsNeverReplaced()
    {
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        var taken = Isolation.CopyRootFor(root, TempBase, 999_994);
        Directory.CreateDirectory(taken);
        File.WriteAllText(Path.Combine(taken, "precious.txt"), "x");

        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase, pid: 999_994);
        Assert.NotEqual(taken, copy.CopyRoot, StringComparer.OrdinalIgnoreCase);
        Assert.True(File.Exists(Path.Combine(taken, "precious.txt")));
        Assert.True(File.Exists(Path.Combine(copy.CopyRoot, "Machine.sln")));
    }

    [Fact] public void UnmarkedFoldersSurviveTheStaleSweep()
    {
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        var lookalike = Isolation.CopyRootFor(root, TempBase, 999_991);
        Directory.CreateDirectory(lookalike);
        File.WriteAllText(Path.Combine(lookalike, "precious.txt"), "x");
        Directory.SetLastWriteTimeUtc(lookalike, DateTime.UtcNow.AddDays(-30));

        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.True(File.Exists(Path.Combine(lookalike, "precious.txt")));
    }

    [Fact] public void KeptCopiesAndCopiesOfOtherSourcesSurviveTheStaleSweep()
    {
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        var kept = Isolation.CopyRootFor(root, TempBase, 999_991);
        var other = Isolation.CopyRootFor(root, TempBase, 999_992);
        foreach (var d in new[] { kept, other }) { Directory.CreateDirectory(d); Directory.SetLastWriteTimeUtc(d, DateTime.UtcNow.AddDays(-30)); }
        Isolation.WriteMarker(kept, Owner(root, 999_991, kept: true));
        Isolation.WriteMarker(other, Owner(ws["elsewhere"], 999_992));

        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.True(Directory.Exists(kept));
        Assert.True(Directory.Exists(other));
    }

    [Fact] public void ReusedProcessIdDoesNotKeepADeadCopyAlive()
    {
        var root = Isolation.RootOf(ws["src/sln/Machine.sln"]);
        var stale = Isolation.CopyRootFor(root, TempBase, Environment.ProcessId) + "-2";
        Directory.CreateDirectory(stale);
        // the recorded owner started long before this process: same id, another process
        Isolation.WriteMarker(stale, Owner(root, Environment.ProcessId, DateTime.UtcNow.AddDays(-9).Ticks));
        Directory.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddDays(-2));

        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.False(Directory.Exists(stale));
    }

    [Fact] public void KeepingACopyMarksItSoNoLaterRunReapsIt()
    {
        var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        copy.Keep = true;
        Assert.True(Isolation.ReadMarker(copy.CopyRoot)!.Kept);
        copy.Keep = false;
        Assert.False(Isolation.ReadMarker(copy.CopyRoot)!.Kept);
        copy.Dispose();
    }

    [Fact] public void IsolateDirBehindAJunctionIntoTheSourceIsRefused()
    {
        var link = ws["junction-to-source"];
        Assert.SkipUnless(WindowsOnly.IsWindows, "junctions are a Windows feature");
        using (var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{ws["src/sln"]}\"")
            { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })!)
            p.WaitForExit();
        if (!Directory.Exists(link)) Assert.Skip("creating a junction failed");
        var e = Assert.Throws<IECodeException>(() => Isolation.Create(ws["src/sln/Machine.sln"], Path.Combine(link, "tmp")));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
        Assert.False(Directory.Exists(ws["src/sln/tmp"]));
    }

    [Fact] public void CopiesOnlyTmcWrittenAfterTheBuildStarted()
    {
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        var start = DateTime.UtcNow;
        var fresh = Path.Combine(copy.CopyRoot, "PLC1", "PLC1.tmc");
        File.WriteAllText(fresh, "new");
        var stale = Path.Combine(copy.CopyRoot, "PLC1", "Gen", "Old.tmc");
        File.WriteAllText(stale, "old");
        File.SetLastWriteTimeUtc(stale, start.AddHours(-1));

        var copied = Isolation.CopyTmcBack(copy, start);
        Assert.Equal([ws["src/sln/PLC1/PLC1.tmc"]], copied);
        Assert.Equal("new", File.ReadAllText(ws["src/sln/PLC1/PLC1.tmc"]));
        Assert.False(File.Exists(ws["src/sln/PLC1/Gen/Old.tmc"]));
    }

    [Fact] public void LinksAreNotFollowed()
    {
        Directory.CreateDirectory(ws["outside"]);
        ws.Touch("outside/secret.TcPOU");
        try { Directory.CreateSymbolicLink(ws["src/sln/link"], ws["outside"]); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // a junction needs no extra rights on Windows
            if (!WindowsOnly.IsWindows) Assert.Skip("creating links needs more rights here");
            using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{ws["src/sln/link"]}\" \"{ws["outside"]}\"")
                { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true })!;
            p.WaitForExit();
            if (!Directory.Exists(ws["src/sln/link"])) Assert.Skip("creating a junction failed");
        }
        using var copy = Isolation.Create(ws["src/sln/Machine.sln"], TempBase);
        Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, "link")));
    }

    [Fact] public void RootIsTheRepositoryOrTheSolutionFolder()
    {
        File.WriteAllText(ws["src/sln/.git"], "gitdir: does-not-exist");   // not a repository
        Assert.Equal(ws["src/sln"], Isolation.RootOf(ws["src/sln/Machine.sln"]));

        using var repo = TempRepo.WithCommittedFile("x.txt", "x");
        File.WriteAllText(Path.Combine(Directory.CreateDirectory(repo["sln"]).FullName, "M.sln"), Sln());
        Assert.Equal(Path.GetFullPath(repo.Root), Isolation.RootOf(repo["sln/M.sln"]), ignoreCase: true);
    }
}
