using System.CommandLine;
using System.Diagnostics;
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
            var state = ShellRegistry.State(e, ShellRegistry.StartTimeOf(e.Pid), ShellRegistry.StartTimeOf(e.OwnerPid));
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
            var failed = 0;
            foreach (var r in targets)
            {
                if (End(r.Entry, ctx.Log))
                {
                    registry.Remove(r.Entry.Pid);
                    killed.Add(r.Entry.Pid);
                    ctx.Log.Success($"Ended PID {r.Entry.Pid}");
                }
                else failed++;
            }
            var data = new { killed, skipped = rows.Except(targets).Select(r => r.Entry.Pid) };
            return failed == 0 ? Outcome.Ok(data) : new Outcome(ExitCodes.Failed, data);
        });
        return cmd;
    }

    /// <summary>Ends a recorded shell; the creation time is checked on the same handle that is killed, so a reused PID is never hit.</summary>
    private static bool End(ShellEntry e, Reporter log)
    {
        try
        {
            using var p = Process.GetProcessById(e.Pid);
            if (!ShellRegistry.IsSame(e, p.StartTime.ToUniversalTime()))
            {
                log.Detail($"PID {e.Pid} is another process now; not touched.");
                return true;
            }
            p.Kill();
            if (p.WaitForExit(TimeSpan.FromSeconds(10))) return true;
            log.Error($"PID {e.Pid} did not end within 10 s.");
            return false;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return true; } // already gone
        catch (System.ComponentModel.Win32Exception ex)
        {
            log.Error($"Ending PID {e.Pid} failed: {ex.Message}");
            return false;
        }
    }
}
