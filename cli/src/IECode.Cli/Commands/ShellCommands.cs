using System.CommandLine;
using IECode.Automation;
using IECode.Core;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary>
/// <c>iecode shells list | kill</c>: the XAE shells iecode started (<see cref="ShellRegistry"/>). Only recorded
/// processes whose PID and creation time still match are touched; a shell whose iecode still runs is spared unless
/// <c>--force</c>.
/// </summary>
internal static class ShellCommands
{
    public static Command Create()
    {
        var cmd = new Command("shells", "XAE shells started by iecode: list them, end the ones a killed run left behind");
        cmd.Subcommands.Add(List());
        cmd.Subcommands.Add(Kill());
        return cmd;
    }

    private sealed record Row(ShellEntry Entry, ShellState State);

    /// <summary>Every recorded shell with its state; stale records (process gone or PID reused) are removed.</summary>
    private static List<Row> Read(ShellRegistry registry, Reporter log)
    {
        var rows = new List<Row>();
        foreach (var e in registry.All())
        {
            var (ownerStart, ownerUnreadable) = ShellRegistry.Probe(e.OwnerPid);
            var state = ShellRegistry.State(e, ShellRegistry.StartTimeOf(e.Pid), ownerStart, ownerUnreadable);
            if (state == ShellState.Stale)
            {
                registry.Remove(e.Pid);
                log.Detail($"Removed the record of PID {e.Pid} (process gone)");
                continue;
            }
            rows.Add(new Row(e, state));
        }
        return rows;
    }

    private static object Json(Row r) => new
    {
        pid = r.Entry.Pid,
        startedUtc = r.Entry.StartedUtc,
        progId = r.Entry.ProgId,
        solution = r.Entry.Solution,
        ownerPid = r.Entry.OwnerPid,
        ownerRunning = r.State == ShellState.Owned,
        state = r.State,
    };

    private static string Describe(Row r) =>
        $"PID {r.Entry.Pid}  {r.Entry.ProgId}  started {r.Entry.StartedUtc.ToLocalTime():yyyy-MM-dd HH:mm}  " +
        (r.State == ShellState.Owned ? $"iecode PID {r.Entry.OwnerPid} still runs" : "orphaned") +
        (r.Entry.Solution is { } s ? $"  {s}" : "");

    private static Command List()
    {
        var cmd = new Command("list", "List the XAE shells iecode started that still run");
        Action(cmd, ctx =>
        {
            var rows = Read(new ShellRegistry(ShellRegistry.DefaultFolder()), ctx.Log);
            if (rows.Count == 0) ctx.Log.Info("No XAE shell started by iecode is running.");
            foreach (var r in rows) ctx.Log.Info(Describe(r));
            return Outcome.Ok(rows.Select(Json));
        });
        return cmd;
    }

    private static Command Kill()
    {
        var force = new Option<bool>("--force") { Description = "Also end shells whose iecode still runs (a live command fails then)" };
        var cmd = new Command("kill", "End the XAE shells iecode started and left behind (asks first; --yes in scripts)") { force };
        Action(cmd, ctx =>
        {
            var registry = new ShellRegistry(ShellRegistry.DefaultFolder());
            var rows = Read(registry, ctx.Log);
            foreach (var r in rows.Where(r => !ShellRegistry.MayKill(r.State, ctx.Get(force))))
                ctx.Log.Warn($"Skipped PID {r.Entry.Pid}: its iecode (PID {r.Entry.OwnerPid}) still runs. --force ends it anyway.");
            var targets = rows.Where(r => ShellRegistry.MayKill(r.State, ctx.Get(force))).ToList();
            if (targets.Count == 0)
            {
                ctx.Log.Info("No XAE shell to end.");
                return Outcome.Ok(new { killed = Array.Empty<int>(), skipped = rows.Select(r => r.Entry.Pid) });
            }
            foreach (var r in targets) ctx.Log.Info(Describe(r));
            if (!ctx.Log.Confirm($"End {targets.Count} XAE shell(s)?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);

            var killed = new List<int>();
            var gone = new List<int>();
            var failed = 0;
            foreach (var r in targets)
            {
                switch (End(r.Entry, ctx.Log))
                {
                    case EndResult.Ended:
                        registry.Remove(r.Entry.Pid);
                        killed.Add(r.Entry.Pid);
                        ctx.Log.Success($"Ended PID {r.Entry.Pid}");
                        break;
                    case EndResult.Gone:
                        registry.Remove(r.Entry.Pid);
                        gone.Add(r.Entry.Pid);
                        ctx.Log.Info($"PID {r.Entry.Pid} had already ended");
                        break;
                    default:
                        failed++;
                        break;
                }
            }
            var data = new { killed, gone, skipped = rows.Except(targets).Select(r => r.Entry.Pid) };
            return failed == 0 ? Outcome.Ok(data) : new Outcome(ExitCodes.Failed, data);
        });
        return cmd;
    }

    private enum EndResult { Ended, Gone, Failed }

    /// <summary>
    /// Ends a recorded shell. The creation-time check, the termination and the wait all go through one process handle
    /// (<see cref="ProcessTermination"/>), so a PID that Windows reuses meanwhile is never hit; a process that cannot be
    /// opened is a failure, not permission to go on.
    /// </summary>
    private static EndResult End(ShellEntry e, Reporter log)
    {
        if (!OperatingSystem.IsWindows()) return EndResult.Gone;   // only Windows records shells
        switch (ProcessTermination.End(e.Pid, e.StartedUtc, TimeSpan.FromSeconds(10), out var detail))
        {
            case ProcessEnd.Ended:
                return EndResult.Ended;
            case ProcessEnd.Gone:
                if (detail is not null) log.Detail($"PID {e.Pid}: {detail}; not touched.");
                return EndResult.Gone;
            default:
                log.Error($"Ending PID {e.Pid} failed: {detail}");
                return EndResult.Failed;
        }
    }
}
