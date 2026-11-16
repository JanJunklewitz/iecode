using System.Runtime.Versioning;
using IECode.Core;
using Microsoft.Win32;

namespace IECode.Automation;

/// <summary>Turns <c>local</c> into the NetId the local runtime answers to (a UMRT does not answer to 127.0.0.1.1.1).</summary>
[SupportedOSPlatform("windows")]
public static class LocalTarget
{
    private static readonly Lazy<AmsNetId?> Detected = new(() => LocalAmsNetId.Detect(ReadRegistry(), RuntimesDir()));

    /// <summary>The NetId to connect to for <paramref name="target"/>.</summary>
    public static AmsNetId Resolve(AmsNetId target) => target.IsLocal ? Detected.Value ?? target : target;

    private static byte[]? ReadRegistry()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Beckhoff\TwinCAT3\System");
            return key?.GetValue("AmsNetId") as byte[];
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

    private static string RuntimesDir() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Beckhoff", "TwinCAT", "3.1", "Runtimes");
}
