using System.CommandLine;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode doctor</c>: checks that this machine can run the TwinCAT commands.</summary>
internal static class DoctorCommand
{
    private sealed record Check(string Name, bool Ok, string Detail);

    public static Command Create()
    {
        var cmd = new Command("doctor", "Check the TwinCAT installation, shells and library repository on this machine");
        Action(cmd, ctx =>
        {
            var checks = new List<Check>
            {
                new("Windows", OperatingSystem.IsWindows(), Environment.OSVersion.ToString()),
            };
            if (OperatingSystem.IsWindows())
            {
                var tcDir = RepTool.TwinCatDir;
                checks.Add(new("TWINCAT3DIR", tcDir is not null && Directory.Exists(tcDir), tcDir ?? "not set"));
                foreach (var progId in XaeShell.CandidateProgIds(TwinCatVersion.Auto))
                    checks.Add(new($"Shell {progId}", Type.GetTypeFromProgID(progId) is not null, Type.GetTypeFromProgID(progId) is null ? "not registered" : "registered"));
                try
                {
                    var tool = RepTool.Find(ctx.Version, null);
                    checks.Add(new("RepTool", true, $"{tool.Exe} · profile {tool.Profile}"));
                }
                catch (IECodeException e) { checks.Add(new("RepTool", false, e.Message)); }
                var repo = LibraryRepository.DefaultPath(tcDir);
                checks.Add(new("Library repository", repo is not null && Directory.Exists(repo), repo ?? "unknown"));
            }

            var shells = checks.Count(c => c.Name.StartsWith("Shell ", StringComparison.Ordinal) && c.Ok);
            foreach (var c in checks)
            {
                // Missing shells are fine as long as one is there.
                var optional = c.Name.StartsWith("Shell ", StringComparison.Ordinal) && shells > 0;
                if (c.Ok) ctx.Log.Success($"{c.Name,-30} {c.Detail}");
                else if (optional) ctx.Log.Info($"  {c.Name,-30} {c.Detail}");
                else ctx.Log.Error($"{c.Name,-30} {c.Detail}");
            }
            var ok = checks.Where(c => !c.Name.StartsWith("Shell ", StringComparison.Ordinal)).All(c => c.Ok) && shells > 0;
            if (!OperatingSystem.IsWindows())
                ctx.Log.Info("On this OS only the file-based commands work: info, lib list/info/update/outdated, clean --artifacts.");
            return new Outcome(ok ? ExitCodes.Ok : ExitCodes.Failed, checks);
        });
        return cmd;
    }
}
