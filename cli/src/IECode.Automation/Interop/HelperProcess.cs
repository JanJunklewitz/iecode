using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using IECode.Core;
using Microsoft.Win32.SafeHandles;

namespace IECode.Automation.Interop;

/// <summary>Reads what <see cref="DialogPolicy.IsTwinCatHelper"/> needs from a running process.</summary>
[SupportedOSPlatform("windows")]
internal static class HelperProcess
{
    /// <summary>
    /// The process is a program of the TwinCAT installation under <paramref name="twinCatDir"/> in this session and no XAE
    /// shell. False for everything that cannot be read (gone, elevated, another user): not attributed means not answered.
    /// </summary>
    public static bool Verify(int pid, string? twinCatDir)
    {
        if (twinCatDir is null) return false;
        try
        {
            using var me = Process.GetCurrentProcess();
            using var p = Process.GetProcessById(pid);
            return DialogPolicy.IsTwinCatHelper(p.ProcessName, ImagePath(p.SafeHandle), twinCatDir, p.SessionId == me.SessionId);
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static string? ImagePath(SafeProcessHandle process)
    {
        var size = 1024;
        var sb = new StringBuilder(size);
        return QueryFullProcessImageName(process, 0, sb, ref size) ? sb.ToString() : null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder exeName, ref int size);
}
