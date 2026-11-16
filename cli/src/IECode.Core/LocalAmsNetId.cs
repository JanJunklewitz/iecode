using System.Globalization;
using System.Xml.Linq;

namespace IECode.Core;

/// <summary>
/// The real AMS NetId behind <c>local</c>. A classic TwinCAT router answers to <c>127.0.0.1.1.1</c>; a user mode runtime (UMRT) does not,
/// it only answers to its own NetId, which is stored in the <c>TcRegistry.xml</c> of the runtime.
/// </summary>
public static class LocalAmsNetId
{
    /// <summary>The NetId to connect to: <paramref name="target"/> itself unless it is <c>local</c> and a real local NetId can be found.</summary>
    public static AmsNetId Resolve(AmsNetId target, byte[]? registryValue, string runtimesDir) =>
        target.IsLocal ? Detect(registryValue, runtimesDir) ?? target : target;

    /// <summary>
    /// The local NetId, or null when none or several are found (no guessing between several UMRT instances).
    /// <paramref name="registryValue"/> is <c>HKLM\SOFTWARE\WOW6432Node\Beckhoff\TwinCAT3\System\AmsNetId</c> (six bytes), null when it is not set.
    /// </summary>
    public static AmsNetId? Detect(byte[]? registryValue, string runtimesDir)
    {
        if (registryValue is { Length: 6 }) return FromBytes(registryValue);

        string[] files;
        try { files = Directory.GetFiles(runtimesDir, "TcRegistry.xml", SearchOption.AllDirectories); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }

        var found = new HashSet<AmsNetId>();
        foreach (var file in files)
        {
            try
            {
                if (FromTcRegistry(File.ReadAllText(file)) is { } id) found.Add(id);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        return found.Count == 1 ? found.First() : null;
    }

    /// <summary>The <c>AmsNetId</c> value (hex bytes) of a <c>TcRegistry.xml</c>, null when there is none or it is malformed.</summary>
    public static AmsNetId? FromTcRegistry(string xml)
    {
        try
        {
            var value = XDocument.Parse(xml).Descendants("Value")
                .FirstOrDefault(v => (string?)v.Attribute("Name") == "AmsNetId" && (string?)v.Attribute("Type") == "BIN");
            var hex = value?.Value.Trim();
            if (hex is not { Length: 12 }) return null;
            var bytes = new byte[6];
            for (var i = 0; i < 6; i++)
                if (!byte.TryParse(hex.AsSpan(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out bytes[i])) return null;
            return FromBytes(bytes);
        }
        catch (System.Xml.XmlException)
        {
            return null;
        }
    }

    private static AmsNetId FromBytes(byte[] b) => new(b[0], b[1], b[2], b[3], b[4], b[5]);
}
