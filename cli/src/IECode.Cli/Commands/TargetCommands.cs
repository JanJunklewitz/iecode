using System.CommandLine;
using System.Globalization;
using System.Runtime.Versioning;
using System.Text;
using System.Threading.Channels;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Ads;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary>
/// <c>iecode target …</c> and <c>iecode ads …</c>: runtime state and PLC variables over ADS, and the ADS interface
/// (symbol table) of a PLC project from its build output, without a running PLC.
/// </summary>
internal static class TargetCommands
{
    private static Option<string> TargetOption() => new("--target", "-t")
    {
        Description = "AMS NetId of the target, or 'local'",
        DefaultValueFactory = _ => "local",
    };

    public static Command Target()
    {
        var cmd = new Command("target", "TwinCAT runtime of a target: state, run mode, config mode (ADS)");

        var t1 = TargetOption();
        var state = new Command("state", "Show the TwinCAT state of a target") { t1 };
        Action(state, ctx =>
        {
            var s = Automation.Target.State(AmsNetId.Parse(ctx.Get(t1)));
            ctx.Log.Info($"{s.NetId}: {s.State}");
            return Outcome.Ok(s);
        }, windowsOnly: true);

        cmd.Subcommands.Add(state);
        cmd.Subcommands.Add(Mode("run", "Restart TwinCAT in run mode", run: true));
        cmd.Subcommands.Add(Mode("config", "Switch TwinCAT to config mode", run: false));
        return cmd;
    }

    private static Command Mode(string name, string description, bool run)
    {
        var t = TargetOption();
        var cmd = new Command(name, description) { t };
        Action(cmd, ctx =>
        {
            var id = AmsNetId.Parse(ctx.Get(t));
            if (!id.IsLocal && !ctx.Log.Confirm($"Switch {id} to {name} mode?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);
            Automation.Target.SetMode(id, run);
            ctx.Log.Success($"{id}: switching to {name} mode");
            return Outcome.Ok(new { target = id.ToString(), mode = name });
        }, windowsOnly: true);
        return cmd;
    }

    public static Command Ads()
    {
        var cmd = new Command("ads", "Read and write PLC variables over ADS; list and compare the ADS interface from the build output");

        var t1 = TargetOption();
        var p1 = PortOption();
        var sym1 = new Argument<string>("symbol") { Description = "Full variable name, e.g. MAIN.bStart or GVL.nCount" };
        var read = new Command("read", "Read a PLC variable") { sym1, t1, p1 };
        Action(read, ctx =>
        {
            var (type, value, text) = Automation.Target.Read(AmsNetId.Parse(ctx.Get(t1)), ctx.Get(p1), ctx.Get(sym1));
            ctx.Log.Info($"{ctx.Get(sym1)} : {type} = {text}");
            return Outcome.Ok(new { symbol = ctx.Get(sym1), type, value, text });
        }, windowsOnly: true);

        var t2 = TargetOption();
        var p2 = PortOption();
        var sym2 = new Argument<string>("symbol") { Description = "Full variable name" };
        var val = new Argument<string>("value") { Description = "New value (BOOL, integer types, REAL, LREAL, STRING, enum name or number, TIME, DATE, DT)" };
        var write = new Command("write", "Write a PLC variable") { sym2, val, t2, p2 };
        Action(write, ctx =>
        {
            var id = AmsNetId.Parse(ctx.Get(t2));
            if (!id.IsLocal && !ctx.Log.Confirm($"Write {ctx.Get(sym2)} := {ctx.Get(val)} on {id}?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);
            var (written, text) = Automation.Target.Write(id, ctx.Get(p2), ctx.Get(sym2), ctx.Get(val));
            ctx.Log.Success($"{ctx.Get(sym2)} := {text}");
            return Outcome.Ok(new { symbol = ctx.Get(sym2), value = written, text });
        }, windowsOnly: true);

        cmd.Subcommands.Add(read);
        cmd.Subcommands.Add(write);
        cmd.Subcommands.Add(Serve());
        cmd.Subcommands.Add(Symbols());
        cmd.Subcommands.Add(Diff());
        return cmd;
    }

    private static Command Serve()
    {
        var t = TargetOption();
        // A string, not Option<int>: a bad port must arrive as a state event after hello, not as a parse error (R3).
        var p = new Option<string>("--port") { Description = "ADS port of the PLC runtime", DefaultValueFactory = _ => "851" };
        var cmd = new Command("serve", "Stream live PLC values: JSON requests on stdin, JSON events and replies on stdout (used by the VS Code extension); runs until stdin closes") { t, p };
        Action(cmd, ctx =>
        {
            if (OperatingSystem.IsWindows()) RunWatchHost(ctx, ctx.Get(t), ctx.Get(p));
            return Outcome.Ok();
        }, windowsOnly: true, protocolStdout: true);
        return cmd;
    }

    /// <summary>
    /// The watch host loop: a reader thread queues stdin lines, this thread handles them and ticks the host every
    /// IntervalMs. EOF is queued behind the lines read before it, so every request gets its reply before the loop ends (C3).
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void RunWatchHost(Context ctx, string target, string port)
    {
        void Emit(string line) => Console.Out.WriteLine(line);
        void Log(string text) => ctx.Log.Warn(text);

        // hello comes from host.Start before anything about the target can fail; a bad -t / --port becomes a state event (R3).
        IWatchBackend backend;
        string? setupError = null;
        try
        {
            var id = AmsNetId.Parse(target);
            if (!int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n is < 1 or > 65535)
                throw new IECodeException(ExitCodes.Usage, $"Invalid ADS port '{port}'.");
            backend = new AdsWatchBackend(id, n, Log);
            ctx.Log.Step($"Serving ADS values of {id}:{n}; requests on stdin, events on stdout, until stdin closes");
        }
        catch (IECodeException e)
        {
            backend = new UnavailableBackend(e.Message);
            setupError = e.Message;
        }

        var lines = Channel.CreateUnbounded<string?>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        var reader = new Thread(() =>
        {
            try
            {
                // UTF-8 explicitly: Program only sets Console.OutputEncoding, stdin would use the OEM code page (O8).
                using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                while (stdin.ReadLine() is { } line) lines.Writer.TryWrite(line);
            }
            catch (IOException e)
            {
                ctx.Log.Warn($"stdin: {e.Message}");
            }
            finally
            {
                lines.Writer.TryWrite(null);
            }
        }) { IsBackground = true, Name = "watch stdin" };

        using (backend)
        {
            var host = new WatchHost(backend, Emit, Log);
            reader.Start();
            host.Start();
            if (setupError is not null) ctx.Log.Error(setupError);
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(host.IntervalMs));
            var tick = timer.WaitForNextTickAsync().AsTask();
            var input = lines.Reader.WaitToReadAsync().AsTask();
            while (true)
            {
                Task.WaitAny(tick, input);
                var eof = false;
                while (!eof && lines.Reader.TryRead(out var line))
                {
                    if (line is null) eof = true;
                    else if (!string.IsNullOrWhiteSpace(line)) host.Handle(line);
                }
                if (eof) break;
                // An interval request takes effect now: setting Period restarts the pending wait with the new period, so a
                // change from 5000 ms to 10 ms does not wait out the old 5 s first.
                if (timer.Period != TimeSpan.FromMilliseconds(host.IntervalMs)) timer.Period = TimeSpan.FromMilliseconds(host.IntervalMs);
                if (input.IsCompleted) input = lines.Reader.WaitToReadAsync().AsTask();
                if (!tick.IsCompleted) continue;
                host.Tick(DateTimeOffset.UtcNow);
                tick = timer.WaitForNextTickAsync().AsTask();
            }
        }
        Console.Out.Flush();
    }

    /// <summary>Backend for a target that cannot even be parsed: every connect fails with the parse error, nothing touches the network.</summary>
    private sealed class UnavailableBackend(string error) : IWatchBackend
    {
        public void Connect() => throw new AdsFault(error, null, true);
        public IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols) => throw new AdsFault(error, null, true);
        public IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatched() => throw new AdsFault(error, null, true);
        public bool SymbolVersionChanged() => false;
        public (string Type, string Value) ReadOnce(string symbol) => throw new AdsFault(error, null, true);
        public string Write(string symbol, string text) => throw new AdsFault(error, null, true);
        public void Dispose() { }
    }

    private static Argument<string?> InterfacePathArg() => new("path")
    {
        Description = ".tmc, .plcproj, .sln or folder (default: current folder)",
        Arity = ArgumentArity.ZeroOrOne,
    };

    private static Option<string?> PlcOption() => new("--plc") { Description = "Only this PLC project (name)" };

    private static Option<bool> MembersOption() => new("--members") { Description = "Expand structs and function blocks to their members (MAIN.fbMotor.bEnable)" };

    /// <summary>The interfaces a user meant: a .tmc, or the .tmc of every built PLC project below a .plcproj / .sln / folder.</summary>
    private static List<AdsInterfaceInfo> LoadInterfaces(Context ctx, string? path, string? plc, bool members)
    {
        var p = string.IsNullOrEmpty(path) ? "." : path;
        if (p.EndsWith(".tmc", StringComparison.OrdinalIgnoreCase)) return [AdsInterface.Load(p, members)];
        var projects = PlcProjectFile.Discover([p])
            .Where(f => plc is null || Path.GetFileNameWithoutExtension(f).Equals(plc, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (projects.Count == 0)
            throw new IECodeException(ExitCodes.NotFound, plc is null ? $"No PLC project found in '{p}'." : $"PLC project '{plc}' not found in '{p}'.");
        var result = new List<AdsInterfaceInfo>();
        foreach (var plcproj in projects)
        {
            var name = Path.GetFileNameWithoutExtension(plcproj);
            if (AdsInterface.FindTmc(plcproj) is not { } tmc)
            {
                // libraries have no runtime interface of their own; only mention them when asked for
                if (projects.Count > 1 && PlcProjectFile.Load(plcproj).IsLibrary) continue;
                ctx.Log.Warn($"{name}: no .tmc next to {Path.GetFileName(plcproj)}. Build the project first (iecode build).");
                continue;
            }
            if (AdsInterface.IsStale(tmc, plcproj)) ctx.Log.Warn($"{name}: source files are newer than {Path.GetFileName(tmc)}. Build again for the current interface.");
            result.Add(AdsInterface.Load(tmc, members) with { Project = name });
        }
        if (result.Count == 0)
            throw new IECodeException(ExitCodes.NotFound, "No build output (.tmc) found.",
                "TwinCAT writes <PLC>.tmc next to the .plcproj when it builds the PLC project. Run 'iecode build' first.");
        return result;
    }

    private static Command Symbols()
    {
        var path = InterfacePathArg();
        var plc = PlcOption();
        var members = MembersOption();
        var filter = new Option<string?>("--filter") { Description = "Only symbols whose name contains this text" };
        var csv = new Option<string?>("--csv") { Description = "Also write the list to a CSV file" };
        var save = new Option<string?>("--save") { Description = "Write a JSON snapshot to compare later builds with (ads diff --against)" };
        var cmd = new Command("symbols", "List the ADS interface (symbols) of PLC projects from the build output (.tmc); no running PLC needed")
            { path, plc, members, filter, csv, save };
        Action(cmd, ctx =>
        {
            var interfaces = LoadInterfaces(ctx, ctx.Get(path), ctx.Get(plc), ctx.Get(members));
            if (ctx.Get(save) is { } snap)
            {
                if (interfaces.Count > 1) throw new IECodeException(ExitCodes.Usage, "--save needs one PLC project.", "Select it with --plc <name> or pass its .plcproj.");
                File.WriteAllText(snap, AdsInterface.ToSnapshot(interfaces[0]), new UTF8Encoding(false));
            }
            if (ctx.Get(filter) is { } f)
                interfaces = interfaces.Select(i => i with { Symbols = i.Symbols.Where(s => s.Name.Contains(f, StringComparison.OrdinalIgnoreCase)).ToList() }).ToList();
            foreach (var i in interfaces)
            {
                ctx.Log.Info($"{i.Project}  ({i.Symbols.Count} symbol(s), {Path.GetFileName(i.Source)})");
                foreach (var s in i.Symbols)
                    ctx.Log.Info($"  {s.Name,-48} {s.Type,-28} {s.SizeText,8}{(s.Comment is null ? "" : "  // " + s.Comment.ReplaceLineEndings(" "))}");
            }
            if (ctx.Get(csv) is { } file)
            {
                File.WriteAllText(file, AdsInterface.ToCsv(interfaces.SelectMany(i => i.Symbols)), new UTF8Encoding(true));
                ctx.Log.Success($"Written {Path.GetFullPath(file)}");
            }
            if (ctx.Get(save) is { } written) ctx.Log.Success($"Snapshot written to {Path.GetFullPath(written)}");
            return Outcome.Ok(interfaces.Select(i => new { project = i.Project, source = i.Source, symbols = i.Symbols }));
        });
        return cmd;
    }

    private static Command Diff()
    {
        var path = InterfacePathArg();
        var plc = PlcOption();
        var members = MembersOption();
        var against = new Option<string>("--against") { Description = "Older interface: snapshot from 'ads symbols --save' or another .tmc", Required = true };
        var csv = new Option<string?>("--csv") { Description = "Also write the changes to a CSV file" };
        var fail = new Option<bool>("--fail-on-change") { Description = "Exit with code 19 if any symbol was added, removed or changed (for CI checks)" };
        var cmd = new Command("diff", "Compare the ADS interface of the current build with a snapshot: added, removed, changed (type / size)")
            { path, plc, members, against, csv, fail };
        Action(cmd, ctx =>
        {
            var old = AdsInterface.Load(ctx.Get(against), ctx.Get(members));
            var expand = old.Members || (ctx.Get(members) && !ctx.Get(against).EndsWith(".json", StringComparison.OrdinalIgnoreCase));
            if (ctx.Get(members) && !expand) ctx.Log.Warn("The snapshot has no members; comparing top-level symbols only. Save it with --members.");
            var current = LoadInterfaces(ctx, ctx.Get(path), ctx.Get(plc), expand);
            if (current.Count > 1) throw new IECodeException(ExitCodes.Usage, "ads diff needs one PLC project.", "Select it with --plc <name> or pass its .plcproj.");
            var now = current[0];
            var changes = AdsInterface.Diff(old.Symbols, now.Symbols);
            ctx.Log.Info($"{now.Project}: {old.Symbols.Count} → {now.Symbols.Count} symbol(s), {changes.Count} change(s)  ({Path.GetFileName(old.Source)} → {Path.GetFileName(now.Source)})");
            foreach (var c in changes)
            {
                var what = c.Kind switch
                {
                    AdsChangeKind.Added => c.After,
                    AdsChangeKind.Removed => $"was {c.Before}",
                    _ => c.Details,
                };
                ctx.Log.Info($"  {c.Kind.ToString().ToLowerInvariant(),-8} {c.Name,-48} {what}");
            }
            if (ctx.Get(csv) is { } file)
            {
                File.WriteAllText(file, AdsInterface.ToCsv(changes), new UTF8Encoding(true));
                ctx.Log.Success($"Written {Path.GetFullPath(file)}");
            }
            if (changes.Count == 0) ctx.Log.Success("No ADS interface changes");
            var data = new { project = now.Project, before = old.Symbols.Count, after = now.Symbols.Count, changes };
            return new Outcome(changes.Count > 0 && ctx.Get(fail) ? ExitCodes.AdsInterfaceChanged : ExitCodes.Ok, data);
        });
        return cmd;
    }

    private static Option<int> PortOption() => new("--port") { Description = "ADS port of the PLC runtime", DefaultValueFactory = _ => 851 };
}
