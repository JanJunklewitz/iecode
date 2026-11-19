using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using IECode.Automation.Interop;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public class ComCallTests
{
    [Fact]
    public void FileInUseIsTransient()
    {
        // What XAE threw while encrypting: "The process cannot access the file … because it is being used by another process."
        Assert.True(ComCall.IsFileLocked(new IOException("The process cannot access the file 'x.TcVIS'.", unchecked((int)0x80070020))));
        Assert.True(ComCall.IsFileLocked(new IOException("I/O error")));
        Assert.True(ComCall.IsFileLocked(new COMException("sharing violation", unchecked((int)0x80070020))));
        Assert.True(ComCall.IsFileLocked(new COMException("lock violation", unchecked((int)0x80070021))));
    }

    [Fact]
    public void OtherErrorsAreNotTransient()
    {
        Assert.False(ComCall.IsFileLocked(new FileNotFoundException("gone")));
        Assert.False(ComCall.IsFileLocked(new DirectoryNotFoundException("gone")));
        Assert.False(ComCall.IsFileLocked(new COMException("busy", unchecked((int)0x80010001))));
        Assert.False(ComCall.IsFileLocked(new InvalidOperationException("no")));
    }
}
