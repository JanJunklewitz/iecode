using System.IO.Pipes;

namespace IECode.Core.Mcp;

/// <summary>Connects to a window's pipe and authenticates; the three-state outcome the window selection relies on.</summary>
public static class PipeConnector
{
    /// <summary>
    /// <see cref="Probe.Absent"/> only when the pipe does not exist: that is proof the window is gone. Everything else that goes wrong
    /// (a timeout, a busy pipe, access denied for a window started elevated, a wrong proof, an early close) is <see cref="Probe.Silent"/>,
    /// because the window may still own the folder and a call must not fall back to a shorter root.
    /// </summary>
    public static Probe Connect(InstanceInfo inst, TimeSpan connectTimeout, TimeSpan handshakeTimeout, string pipeRoot = @"\\.\pipe\")
    {
        if (!PipeExists(inst.Pipe, pipeRoot)) return new Probe.Absent();
        var pipe = new NamedPipeClientStream(".", inst.Pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            pipe.Connect((int)connectTimeout.TotalMilliseconds);
            if (BridgeHandshake.Run(pipe, inst, handshakeTimeout)) return new Probe.Ok(pipe);
        }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException) { }
        pipe.Dispose();
        return new Probe.Silent();
    }

    /// <summary>
    /// Existence by directory listing: it does not open the pipe, so it uses up none of the server's instances (a paused window has
    /// few). When the listing itself fails the pipe counts as existing and the connect decides.
    /// </summary>
    public static bool PipeExists(string name, string pipeRoot = @"\\.\pipe\")
    {
        try { return Directory.GetFiles(pipeRoot, name).Length > 0; }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException) { return true; }
    }
}
