namespace IECode.Core.Tests;

public class PathLengthTests
{
    static string Deep(int levels) => string.Join('/', Enumerable.Repeat("folder_name_x", levels));

    [Fact] public void ShortTreeGivesNull()
    {
        using var ws = new TempWorkspace();
        ws.Touch("t/a/b.TcPOU");
        Assert.Null(PathLength.Longest(ws["t"]));
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
}
