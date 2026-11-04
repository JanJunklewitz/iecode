using System.IO.Pipes;
using System.CommandLine;
using IECode.Core.Mcp;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary>
/// <c>iecode mcp</c>: the stdio MCP server Claude Code starts. It relays the ADS tools to the VS Code window that serves the
/// working directory (see <see cref="McpBridge"/>); registered once per user with <c>claude mcp add -s user</c>.
/// </summary>
internal static class McpCommand
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(2);

    public static Command Create()
    {
        var cmd = new Command("mcp", "Relay MCP tool calls from Claude Code to the IECode VS Code window of the working directory: MCP lines on stdin and stdout, until stdin closes (started by Claude Code, see the README)");
        Action(cmd, ctx =>
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iecode", "mcp", "v1");
            using var stdin = Console.OpenStandardInput();
            using var stdout = Console.OpenStandardOutput();
            var bridge = new McpBridge(Directory.GetCurrentDirectory(), Path.Combine(root, "instances"), Path.Combine(root, "tools.json"),
                Connect, stdin, stdout, text => Console.Error.WriteLine(text));
            bridge.RunAsync(CancellationToken.None).GetAwaiter().GetResult();
            return Outcome.Ok();
        }, windowsOnly: true, protocolStdout: true);
        return cmd;
    }

    /// <summary>
    /// Connect and authenticate. A pipe that does not exist or refuses is proof the window is gone; every timeout, early close or wrong
    /// proof is silence, never "gone", so a paused window is not mistaken for a closed one.
    /// </summary>
    private static Probe Connect(InstanceInfo inst)
    {
        if (!File.Exists(@"\\.\pipe\" + inst.Pipe)) return new Probe.Absent();
        var pipe = new NamedPipeClientStream(".", inst.Pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            pipe.Connect((int)ConnectTimeout.TotalMilliseconds);
            if (BridgeHandshake.Run(pipe, inst, HandshakeTimeout)) return new Probe.Ok(pipe);
            pipe.Dispose();
            return new Probe.Silent();
        }
        catch (TimeoutException)
        {
            pipe.Dispose();
            return new Probe.Silent();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            pipe.Dispose();
            return new Probe.Absent();
        }
    }
}
