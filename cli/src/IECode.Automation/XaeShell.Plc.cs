using System.Runtime.InteropServices;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation;

/// <summary>A PLC project inside a TwinCAT project: the tree root ("PLC1") and its nested IEC project ("PLC1 Project").</summary>
internal sealed record PlcHandle(string Name, string NestedName, string TreePath, object SysManager, object Project, object Nested);

public sealed partial class XaeShell
{
    internal IEnumerable<PlcHandle> PlcProjects()
    {
        foreach (var (project, sysMan, _) in TwinCatProjects())
        {
            object? tipc;
            try { tipc = ComCall.Retry(() => (object?)sysMan.LookupTreeItem("TIPC")); }
            catch (COMException) { continue; }
            if (tipc is null) continue;
            foreach (var root in ComCall.Children(tipc))
            {
                object? nested;
                try { nested = ComCall.Retry(() => (object?)root.NestedProject); }
                catch (Exception e) when (e is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { continue; }
                if (nested is null) continue;
                dynamic n = nested;
                yield return new PlcHandle(
                    ComCall.Retry(() => (string)root.Name),
                    ComCall.Retry(() => (string)n.Name),
                    ComCall.Retry(() => (string)n.PathName),
                    sysMan, project, nested);
            }
        }
    }

    /// <summary>Finds one PLC project by name (tree name or nested name); without a name there must be exactly one.</summary>
    internal PlcHandle FindPlc(string? name)
    {
        var all = PlcProjects().ToList();
        if (all.Count == 0) throw new IECodeException(ExitCodes.NotFound, "The solution contains no PLC project.");
        if (name is null)
            return all.Count == 1 ? all[0]
                : throw new IECodeException(ExitCodes.Usage, "The solution contains several PLC projects.",
                    "Choose one with --plc: " + string.Join(", ", all.Select(p => p.Name)));
        return all.FirstOrDefault(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase) || p.NestedName.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? throw new IECodeException(ExitCodes.NotFound, $"PLC project '{name}' not found.",
                "Available: " + string.Join(", ", all.Select(p => p.Name)));
    }

    /// <summary>Saves a PLC project as .library or .compiled-library (and optionally installs it in the local repository).</summary>
    public string SaveAsLibrary(string? plcName, string outFile, bool install)
    {
        var plc = FindPlc(plcName);
        var full = Path.GetFullPath(outFile);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        if (File.Exists(full)) File.Delete(full);

        _log.Step($"Saving {plc.Name} as {Path.GetFileName(full)}{(install ? " and installing it" : "")}…");
        dynamic nested = plc.Nested;
        try { ComCall.Retry(() => { nested.SaveAsLibrary(full, install); }); }
        catch (COMException e)
        {
            throw new IECodeException(ExitCodes.LibraryFailed, $"Save as library failed: {e.Message}",
                "The project needs library properties (Title, Company, Version) and must compile without errors.", e);
        }

        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(2);
        while (!File.Exists(full) && DateTime.UtcNow < deadline) Thread.Sleep(250);
        if (!File.Exists(full)) throw new IECodeException(ExitCodes.LibraryFailed, $"TwinCAT reported success but '{full}' was not written.");
        return full;
    }

    /// <summary>Applies object protection (encryption, signing, protection level) to one tree item and saves.</summary>
    public void SetProtection(ProtectionSpec spec)
    {
        var hits = 0;
        foreach (var (project, sysMan, file) in TwinCatProjects())
        {
            object? item;
            try { item = ComCall.Retry(() => (object?)sysMan.LookupTreeItem(spec.ItemPath)); }
            catch (COMException) { continue; }
            if (item is null) continue;
            hits++;
            dynamic it = item;
            _log.Step($"Protecting {spec.ItemPath} in {Path.GetFileName(file)}");
            if (spec.Level is not null) SetAndConfirm(() => (string)it.ObjectProtectionLevel, v => it.ObjectProtectionLevel = v, spec.Level, "protection level");
            if (spec.Encrypted is bool enc) SetAndConfirm(() => (bool)it.EncryptFile, v => it.EncryptFile = v, enc, "encryption");
            if (spec.Signed is bool sig) SetAndConfirm(() => (bool)it.SignFile, v => it.SignFile = v, sig, "signing");
            ComCall.Retry(() => { project.Save(); });
        }
        if (hits == 0)
            throw new IECodeException(ExitCodes.ProtectionFailed, $"Item '{spec.ItemPath}' not found in any TwinCAT project.",
                "Use the tree path as shown in XAE, separated by ^, e.g. TIPC^PLC1^PLC1 Project^POUs.");
    }

    /// <summary>
    /// Writes a protection property and waits until the shell reports the new value. These setters
    /// re-encrypt files in the background and may reject calls while they run.
    /// </summary>
    private void SetAndConfirm<T>(Func<T> get, Action<T> set, T value, string what)
    {
        if (EqualityComparer<T>.Default.Equals(ComCall.Retry(get), value)) { _log.Detail($"{what} already {value}"); return; }
        try { ComCall.Retry(() => set(value), attempts: 40, delayMs: 1000); }
        catch (COMException e) { throw new IECodeException(ExitCodes.ProtectionFailed, $"Setting {what} failed: {e.Message}", inner: e); }

        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(2);
        while (DateTime.UtcNow < deadline)
        {
            try { if (EqualityComparer<T>.Default.Equals(get(), value)) { _log.Detail($"{what} = {value}"); return; } }
            catch (COMException e) when (ComCall.IsBusy(e)) { }
            _log.Status($"Waiting for {what}… {StatusText()}");
            Thread.Sleep(1000);
        }
        throw new IECodeException(ExitCodes.Timeout, $"TwinCAT did not confirm {what} = {value} within 2 minutes.");
    }

    /// <summary>
    /// Activates the configuration of a TwinCAT project on a target and optionally restarts TwinCAT in run mode.
    /// Known blocking dialogs (symbol type change) are confirmed automatically.
    /// </summary>
    public void Activate(AmsNetId target, bool restart, string? projectName)
    {
        var candidates = TwinCatProjects(includePlcOnly: false).ToList();
        if (candidates.Count == 0) throw new IECodeException(ExitCodes.NotFound, "The solution has no TwinCAT system project (.tsproj) to activate.");
        var chosen = projectName is null ? candidates[0]
            : candidates.FirstOrDefault(c => Path.GetFileNameWithoutExtension(c.File).Equals(projectName, StringComparison.OrdinalIgnoreCase));
        if (chosen.SysManager is null)
            throw new IECodeException(ExitCodes.NotFound, $"TwinCAT project '{projectName}' not found.",
                "Available: " + string.Join(", ", candidates.Select(c => Path.GetFileNameWithoutExtension(c.File))));
        if (projectName is null && candidates.Count > 1)
            _log.Warn($"Several TwinCAT projects; activating {Path.GetFileNameWithoutExtension(chosen.File)}. Choose with --project.");

        dynamic sysMan = chosen.SysManager;
        dynamic project = chosen.Project;
        var current = ComCall.Retry(() => (string)sysMan.GetTargetNetId());
        if (!AmsNetId.TryParse(current, out var currentId) || currentId != target)
        {
            ComCall.Retry(() => { sysMan.SetTargetNetId(target.ToString()); });
            _log.Detail($"Target {current} → {target}");
        }
        SaveAll();

        using var confirmer = DialogConfirmer.Start(_log);
        _log.Step($"Activating configuration on {(target.IsLocal ? "local system" : target.ToString())}…");
        try
        {
            ComCall.Retry(() => { sysMan.ActivateConfiguration(); });
            ComCall.Retry(() => { project.Save(); });
            if (restart)
            {
                _log.Step("Restarting TwinCAT in run mode…");
                ComCall.Retry(() => { sysMan.StartRestartTwinCAT(); });
            }
        }
        catch (COMException e)
        {
            throw new IECodeException(ExitCodes.ActivationFailed, $"Activation on {target} failed: {e.Message}",
                "Check the ADS route to the target and that the license is valid. Try with --visible to see XAE.", e);
        }
    }
}
