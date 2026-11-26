namespace IECode.Core.Tests;

public class PathLengthTests
{
    static string Deep(int levels) => string.Join('/', Enumerable.Repeat("folder_name_x", levels));

    [Fact] public void ShortTreeGivesItsLongestPath()
    {
        using var ws = new TempWorkspace();
        var file = ws.Touch("t/a/b.TcPOU");
        // no cutoff: the caller judges the length, an isolated copy may make a short path long
        Assert.Equal(file, PathLength.Longest(ws["t"]));
    }

    [Fact] public void ReportsThePathAtTheLimit()
    {
        using var ws = new TempWorkspace();
        ws.Touch("t/short.TcPOU");
        var deep = ws.Touch("t/" + Deep(12) + "/Visualization Manager.TcVMO");
        Assert.True(deep.Length >= PathLength.WarnAt);
        Assert.Equal(deep, PathLength.Longest(ws["t"]));
    }

    [Fact] public void OnlyProjectFilesCount()
    {
        using var ws = new TempWorkspace();
        ws.Touch("t/" + Deep(12) + "/notes.txt");
        ws.Touch("t/.git/" + Deep(12) + "/x.TcPOU");
        ws.Touch("t/PLC/_CompileInfo/" + Deep(12) + "/x.TcPOU");
        Assert.Null(PathLength.Longest(ws["t"]));
    }

    [Fact] public void WarningSuggestsIsolateOnlyWhenTheCopyIsShorter()
    {
        var root = @"C:\a\very\long\root\folder\name";
        var file = root + @"\PLC\" + new string('x', 200) + ".TcPOU";
        Assert.Contains("--isolate", PathLength.Warning(file, root, @"C:\t\b\1234abcd-42"));
        Assert.DoesNotContain("--isolate", PathLength.Warning(file, root, root + @"\even\longer\copy\root"));
    }

    [Fact] public void ShortSourcePathThatBecomesLongInTheCopyIsWarnedAbout()
    {
        var root = @"C:\r";
        var file = root + @"\PLC\" + new string('x', 180) + ".TcPOU";
        Assert.True(file.Length < PathLength.WarnAt);
        Assert.Null(PathLength.Warning(file, root, @"C:\r", isolating: false));
        Assert.Contains("--isolate-dir", PathLength.Warning(file, root, @"C:\temp\some\isolate\dir\b\abcd1234-42", isolating: true));
    }

    [Fact] public void IsolatedBuildIsJudgedByThePathInTheCopy()
    {
        var root = @"C:\a\very\long\root\folder\name";
        var file = root + @"\PLC\" + new string('x', 160) + ".TcPOU";
        Assert.Null(PathLength.Warning(file, root, @"C:\t\b\1234abcd-42", isolating: true));
        var stillLong = PathLength.Warning(file, root, @"C:\t\much\longer\isolate\dir\b\1234abcd-42", isolating: true);
        Assert.Contains("--isolate-dir", stillLong);
    }
}
