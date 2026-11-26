using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using IECode.Automation.Interop;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public class RunningObjectsTests
{
    [DllImport("ole32.dll")] private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable rot);
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)] private static extern int CreateItemMoniker(string delimiter, string item, out IMoniker moniker);

    // a pattern of its own, so the test never meets a real Visual Studio of the machine
    private static Regex Pattern(string name) => new($@"^!{name}:(?<pid>\d+)$");

    private static IDisposable Register(object obj, string display)
    {
        GetRunningObjectTable(0, out var rot);
        CreateItemMoniker("!", display, out var moniker);
        var cookie = rot.Register(1 /* strong */, obj, moniker);
        return new Revoke(rot, cookie);
    }

    private sealed class Revoke(IRunningObjectTable rot, int cookie) : IDisposable
    {
        public void Dispose() => rot.Revoke(cookie);
    }

    [Fact]
    public void TheEntryThatHoldsTheObjectNamesItsProcess()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "running object table");
        var name = "IecodeTestDte" + Guid.NewGuid().ToString("N");
        var dte = new object();
        using (Register(dte, name + ":4711"))
            Assert.Equal(4711, RunningObjects.ServerPidOf(dte, Pattern(name)));
    }

    [Fact]
    public void AnotherObjectInTheTableIsNoProof()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "running object table");
        var name = "IecodeTestDte" + Guid.NewGuid().ToString("N");
        using (Register(new object(), name + ":4711"))
            // a different shell is running, ours is not in the table: nothing is proven
            Assert.Null(RunningObjects.ServerPidOf(new object(), Pattern(name)));
    }

    [Fact]
    public void WithoutAnEntryNothingIsProven()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "running object table");
        Assert.Null(RunningObjects.ServerPidOf(new object(), Pattern("IecodeTestNoSuchEntry" + Guid.NewGuid().ToString("N"))));
    }
}
