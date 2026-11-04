using System.Diagnostics;
using IECode.Core.Mcp;

namespace IECode.Core.Tests;

public sealed class McpSelectionTests
{
    private static InstanceInfo I(string id, params string[] roots) => McpTestData.Instance(id, roots, workspace: "ws-" + id);

    /// <summary>A fake `connect`: per instance id a probe, recording which windows were probed and the streams handed out.</summary>
    private sealed class Probes
    {
        private readonly Dictionary<string, Func<Probe>> _by = new();
        public readonly List<string> Called = [];
        public readonly List<LinkEnd> Links = [];

        public Probes Ok(string id) { _by[id] = () => { var (a, _) = LinkEnd.Pair(); lock (Links) Links.Add(a); return new Probe.Ok(a); }; return this; }
        public Probes Absent(string id) { _by[id] = () => new Probe.Absent(); return this; }
        public Probes Silent(string id) { _by[id] = () => new Probe.Silent(); return this; }

        public Probe Connect(InstanceInfo inst)
        {
            lock (Called) Called.Add(inst.Id);
            return _by[inst.Id]();
        }
    }

    private static Selection Choose(string cwd, Probes p, params InstanceInfo[] all) => Selection.Choose(cwd, all, p.Connect);

    [Fact(Skip = "Windows only", SkipUnless = nameof(WindowsOnly.IsWindows), SkipType = typeof(WindowsOnly))]
    public void CanonicalPath_IgnoresDriveCaseAndTrailingSeparator()
    {
        Assert.Equal(PathMatch.Canonical("c:\\Work\\Plant"), PathMatch.Canonical("C:\\Work\\Plant\\"));
        Assert.Equal("c:\\", PathMatch.Canonical("C:\\"));
        Assert.True(PathMatch.Contains("C:\\Work\\Plant\\", "c:\\work\\plant"));
    }

    [Fact(Skip = "Windows only", SkipUnless = nameof(WindowsOnly.IsWindows), SkipType = typeof(WindowsOnly))]
    public void CanonicalPath_ResolvesAJunction()
    {
        var dir = Path.Combine(Path.GetTempPath(), "iecode-mcp-" + Guid.NewGuid().ToString("N"));
        var real = Path.Combine(dir, "real");
        var link = Path.Combine(dir, "link");
        Directory.CreateDirectory(real);
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{real}\"") { CreateNoWindow = true, RedirectStandardOutput = true };
            using (var p = Process.Start(psi)!) { p.WaitForExit(); Assert.Equal(0, p.ExitCode); }
            Assert.Equal(PathMatch.Canonical(real), PathMatch.Canonical(link));
            Assert.True(PathMatch.Contains(real, Path.Combine(link, "sub")));
        }
        finally
        {
            if (Directory.Exists(link)) Directory.Delete(link); // the junction itself, not its target
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Plant_DoesNotMatchPlantOld()
    {
        Assert.False(PathMatch.Contains("c:\\work\\plant", "c:\\work\\plant-old"));
        Assert.False(PathMatch.Contains("c:\\work\\plant", "c:\\work\\plant-old\\src"));
        Assert.IsType<Selection.None>(Choose("c:\\work\\plant-old", new Probes().Ok("a"), I("a", "c:\\work\\plant")));
    }

    [Fact]
    public void ASubfolderOfARoot_Matches()
    {
        var chosen = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant\\src\\x", new Probes().Ok("a"), I("a", "c:\\work\\plant")));
        Assert.Equal("a", chosen.Instance.Id);
    }

    [Fact]
    public void TheLongestRootWins()
    {
        var p = new Probes().Ok("outer").Ok("inner");
        var chosen = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant\\sub", p, I("outer", "c:\\work"), I("inner", "c:\\work\\plant")));
        Assert.Equal("inner", chosen.Instance.Id);
        Assert.DoesNotContain("outer", p.Called);
    }

    [Fact]
    public void AMultiRootInstance_MatchesThroughAnyRoot()
    {
        var chosen = Assert.IsType<Selection.Chosen>(Choose("d:\\other\\x", new Probes().Ok("m"), I("m", "c:\\work", "d:\\other")));
        Assert.Equal("m", chosen.Instance.Id);
    }

    [Fact]
    public void TwoLiveInstancesWithTheSameBestRoot_AreAConflict()
    {
        var p = new Probes().Ok("a").Ok("b");
        var conflict = Assert.IsType<Selection.Conflict>(Choose("c:\\work\\plant", p, I("a", "c:\\work\\plant"), I("b", "c:\\work\\plant")));
        Assert.Equal(["a", "b"], conflict.Instances.Select(i => i.Id).Order());
        Assert.All(p.Links, l => Assert.True(l.Disposed));
    }

    [Fact]
    public void AnAbsentInstance_IsNeitherMatchNorConflict()
    {
        var p = new Probes().Ok("a").Absent("b");
        var chosen = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant", p, I("a", "c:\\work\\plant"), I("b", "c:\\work\\plant")));
        Assert.Equal("a", chosen.Instance.Id);
    }

    [Fact]
    public void AnAbsentInstanceWithTheLongestRoot_FallsBackToTheNextGroup()
    {
        var p = new Probes().Absent("inner").Ok("outer");
        var chosen = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant", p, I("inner", "c:\\work\\plant"), I("outer", "c:\\work")));
        Assert.Equal("outer", chosen.Instance.Id);
    }

    [Fact]
    public void APausedWindowWithTheLongestRoot_BlocksTheFallback()
    {
        var p = new Probes().Silent("inner").Ok("outer");
        var unsure = Assert.IsType<Selection.Unsure>(Choose("c:\\work\\plant", p, I("inner", "c:\\work\\plant"), I("outer", "c:\\work")));
        Assert.Equal(["inner"], unsure.Instances.Select(i => i.Id));
        Assert.DoesNotContain("outer", p.Called); // never probed for a decision
    }

    [Fact]
    public void APausedWindowWithTheSameRoot_BlocksInsteadOfChoosingTheOther()
    {
        var p = new Probes().Ok("a").Silent("b");
        var unsure = Assert.IsType<Selection.Unsure>(Choose("c:\\work\\plant", p, I("a", "c:\\work\\plant"), I("b", "c:\\work\\plant")));
        Assert.Equal(["b"], unsure.Instances.Select(i => i.Id));
        Assert.All(p.Links, l => Assert.True(l.Disposed));
    }

    [Fact]
    public void ASilentWindow_NeverCountsAsGone()
    {
        // a wrong proof or a timeout is Silent: the result is Unsure, not None
        Assert.IsType<Selection.Unsure>(Choose("c:\\work\\plant", new Probes().Silent("a"), I("a", "c:\\work\\plant")));
        Assert.IsType<Selection.Unsure>(Selection.Choose("c:\\work\\plant", [I("a", "c:\\work\\plant")], _ => throw new InvalidOperationException("boom")));
    }

    [Fact]
    public void NoCandidate_GivesNone()
    {
        Assert.IsType<Selection.None>(Choose("c:\\elsewhere", new Probes(), I("a", "c:\\work\\plant")));
        Assert.IsType<Selection.None>(Choose("c:\\work", new Probes()));
        Assert.IsType<Selection.None>(Choose("c:\\work\\plant", new Probes().Absent("a"), I("a", "c:\\work\\plant")));
    }

    [Fact]
    public void AProtocolRangeWithoutOne_GivesVersionMismatch()
    {
        var old = McpTestData.Instance("n", ["c:\\work\\plant"], min: 2, max: 3);
        var pn = new Probes().Ok("n");
        var mismatch = Assert.IsType<Selection.VersionMismatch>(Choose("c:\\work\\plant", pn, old));
        Assert.Equal("n", mismatch.Instance.Id);
        Assert.All(pn.Links, l => Assert.True(l.Disposed));
    }

    [Fact]
    public void AMismatchingWindowWithTheLongestRoot_BlocksTheFallback()
    {
        // the window that owns the folder speaks another protocol: nothing may go to the shorter root
        var newer = McpTestData.Instance("n", ["c:\\work\\plant"], min: 2, max: 3);
        var p = new Probes().Ok("n").Ok("outer");
        Assert.IsType<Selection.VersionMismatch>(Choose("c:\\work\\plant", p, newer, I("outer", "c:\\work")));
        Assert.DoesNotContain("outer", p.Called);
    }

    [Fact]
    public void AMismatchingWindowThatIsGone_FallsBack_AndAShorterMismatchDoesNotBlock()
    {
        var newer = McpTestData.Instance("n", ["c:\\work\\plant"], min: 2, max: 3);
        var gone = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant", new Probes().Absent("n").Ok("outer"), newer, I("outer", "c:\\work")));
        Assert.Equal("outer", gone.Instance.Id);
        var shorter = McpTestData.Instance("m", ["c:\\work"], min: 2, max: 3);
        var usable = Assert.IsType<Selection.Chosen>(Choose("c:\\work\\plant", new Probes().Ok("a").Ok("m"), I("a", "c:\\work\\plant"), shorter));
        Assert.Equal("a", usable.Instance.Id);
        Assert.IsType<Selection.None>(Choose("c:\\work\\plant", new Probes().Absent("n"), newer));
    }

    // ---- Instances.Load ----

    private static string TempDir()
    {
        var d = Path.Combine(Path.GetTempPath(), "iecode-inst-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        return d;
    }

    private const string GoodFile = """{"format":1,"id":"a1","pid":7,"startedAt":"2026-11-04T00:00:00Z","extensionVersion":"0.2.6","bridgeProtocol":{"min":1,"max":1},"pipe":"iecode-mcp-a1","roots":["c:\\work\\plant"],"workspaceName":"plant","rootsRevision":1,"secret":"AAAA"}""";

    [Fact]
    public void Load_ReadsAFormat1File_AndIgnoresTempFiles()
    {
        var dir = TempDir();
        try
        {
            File.WriteAllText(Path.Combine(dir, "a1.json"), GoodFile);
            File.WriteAllText(Path.Combine(dir, "b2.tmp"), GoodFile.Replace("a1", "b2"));
            var all = Instances.Load(dir);
            var a = Assert.Single(all);
            Assert.Equal(("a1", "iecode-mcp-a1", "plant", "AAAA"), (a.Id, a.Pipe, a.WorkspaceName, a.Secret));
            Assert.Equal(["c:\\work\\plant"], a.Roots);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Load_SkipsAFileWithAMalformedPipeNameOrRoot()
    {
        var dir = TempDir();
        try
        {
            File.WriteAllText(Path.Combine(dir, "a.json"), GoodFile.Replace("iecode-mcp-a1", "..\\evil"));
            File.WriteAllText(Path.Combine(dir, "b.json"), GoodFile.Replace("iecode-mcp-a1", "a*b"));
            File.WriteAllText(Path.Combine(dir, "c.json"), GoodFile.Replace("\"roots\":[\"c:\\\\work\\\\plant\"]", "\"roots\":[\"\"]"));
            File.WriteAllText(Path.Combine(dir, "d.json"), GoodFile.Replace("\"roots\":[\"c:\\\\work\\\\plant\"]", "\"roots\":[null]"));
            File.WriteAllText(Path.Combine(dir, "good.json"), GoodFile);
            Assert.Equal(["a1"], Instances.Load(dir).Select(i => i.Id));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Load_SkipsAnUnreadableFile_AndAFormat2File_AndAMissingDirectory()
    {
        var dir = TempDir();
        try
        {
            File.WriteAllText(Path.Combine(dir, "bad.json"), "{not json");
            File.WriteAllText(Path.Combine(dir, "v2.json"), GoodFile.Replace("\"format\":1", "\"format\":2"));
            File.WriteAllText(Path.Combine(dir, "partial.json"), """{"format":1,"id":"x"}""");
            File.WriteAllText(Path.Combine(dir, "good.json"), GoodFile);
            Assert.Equal(["a1"], Instances.Load(dir).Select(i => i.Id));
            Assert.Empty(Instances.Load(Path.Combine(dir, "nope")));
        }
        finally { Directory.Delete(dir, true); }
    }
}
