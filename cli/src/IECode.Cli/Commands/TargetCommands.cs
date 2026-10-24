using System.CommandLine;
using IECode.Automation;
using IECode.Core;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode target …</c> and <c>iecode ads …</c>: runtime state and PLC variables over ADS.</summary>
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
        var cmd = new Command("ads", "Read and write PLC variables over ADS");

        var t1 = TargetOption();
        var p1 = PortOption();
        var sym1 = new Argument<string>("symbol") { Description = "Full variable name, e.g. MAIN.bStart or GVL.nCount" };
        var read = new Command("read", "Read a PLC variable") { sym1, t1, p1 };
        Action(read, ctx =>
        {
            var (type, value) = Automation.Target.Read(AmsNetId.Parse(ctx.Get(t1)), ctx.Get(p1), ctx.Get(sym1));
            ctx.Log.Info($"{ctx.Get(sym1)} : {type} = {value}");
            return Outcome.Ok(new { symbol = ctx.Get(sym1), type, value });
        }, windowsOnly: true);

        var t2 = TargetOption();
        var p2 = PortOption();
        var sym2 = new Argument<string>("symbol") { Description = "Full variable name" };
        var val = new Argument<string>("value") { Description = "New value (BOOL, integer types, REAL, LREAL, STRING)" };
        var write = new Command("write", "Write a PLC variable") { sym2, val, t2, p2 };
        Action(write, ctx =>
        {
            var id = AmsNetId.Parse(ctx.Get(t2));
            if (!id.IsLocal && !ctx.Log.Confirm($"Write {ctx.Get(sym2)} := {ctx.Get(val)} on {id}?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);
            var written = Automation.Target.Write(id, ctx.Get(p2), ctx.Get(sym2), ctx.Get(val));
            ctx.Log.Success($"{ctx.Get(sym2)} := {written}");
            return Outcome.Ok(new { symbol = ctx.Get(sym2), value = written });
        }, windowsOnly: true);

        cmd.Subcommands.Add(read);
        cmd.Subcommands.Add(write);
        return cmd;
    }

    private static Option<int> PortOption() => new("--port") { Description = "ADS port of the PLC runtime", DefaultValueFactory = _ => 851 };
}
