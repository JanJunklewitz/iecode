using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;

namespace IECode.Automation.Interop;

/// <summary>
/// Tells which process serves a DTE object. A shell registers its DTE in the running object table as
/// <c>!VisualStudio.DTE.17.0:&lt;pid&gt;</c> (TwinCAT's shell as <c>!TcXaeShell.DTE.…:&lt;pid&gt;</c>); the entry whose object is
/// the very COM object we got from CreateInstance names the process. <c>DTE.MainWindow.HWnd</c> cannot be used: it is empty
/// through late binding.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class RunningObjects
{
    [GeneratedRegex(@"^!(?:VisualStudio|TcXaeShell)\.DTE\.[0-9.]+:(?<pid>\d+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ShellMoniker();

    /// <summary>The PID in the moniker of the entry that holds <paramref name="dte"/> itself; null when no entry does (yet).</summary>
    public static int? ServerPidOf(object dte) => ServerPidOf(dte, ShellMoniker());

    /// <param name="monikerPattern">Display names to look at; the <c>pid</c> group is the process id. A seam for tests.</param>
    internal static int? ServerPidOf(object dte, Regex monikerPattern)
    {
        IntPtr identity = IntPtr.Zero;
        IBindCtx? bind = null;
        IRunningObjectTable? rot = null;
        IEnumMoniker? monikers = null;
        try
        {
            if (GetRunningObjectTable(0, out rot) != 0 || CreateBindCtx(0, out bind) != 0) return null;
            identity = Marshal.GetIUnknownForObject(dte);
            rot.EnumRunning(out monikers);
            var one = new IMoniker[1];
            while (monikers.Next(1, one, IntPtr.Zero) == 0)
            {
                var moniker = one[0];
                try
                {
                    moniker.GetDisplayName(bind, null, out var name);
                    if (monikerPattern.Match(name ?? "") is not { Success: true } m) continue;
                    if (rot.GetObject(moniker, out var entry) != 0 || entry is null) continue;
                    IntPtr entryIdentity = IntPtr.Zero;
                    try
                    {
                        entryIdentity = Marshal.GetIUnknownForObject(entry);
                        if (entryIdentity == identity) return int.Parse(m.Groups["pid"].Value);
                    }
                    finally
                    {
                        if (entryIdentity != IntPtr.Zero) Marshal.Release(entryIdentity);
                        // the entry may be the very RCW of the DTE object: that one stays with its owner
                        if (!ReferenceEquals(entry, dte) && Marshal.IsComObject(entry)) Marshal.ReleaseComObject(entry);
                    }
                }
                catch (COMException) { }   // an entry whose server is gone or busy is no candidate
                finally { Marshal.ReleaseComObject(moniker); }
            }
            return null;
        }
        catch (COMException) { return null; }
        finally
        {
            if (identity != IntPtr.Zero) Marshal.Release(identity);
            if (monikers is not null) Marshal.ReleaseComObject(monikers);
            if (rot is not null) Marshal.ReleaseComObject(rot);
            if (bind is not null) Marshal.ReleaseComObject(bind);
        }
    }

    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable rot);

    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(int reserved, out IBindCtx bind);
}
