using System.Runtime.Versioning;
using IECode.Core.Ads;
using TwinCAT.TypeSystem;

namespace IECode.Automation;

/// <summary>Bridges TwinCAT type information to <see cref="PlcValueText"/>: alias resolution, enum members and PlcOpen date/time values.</summary>
[SupportedOSPlatform("windows")]
public static class AdsValues
{
    /// <summary>Follows aliases down to the underlying type and returns its name plus the enum members, if it is an enum.</summary>
    public static (string BaseType, IReadOnlyDictionary<long, string>? EnumMembers) Resolve(IDataType? type)
    {
        for (var i = 0; type is not null && i < 32; i++)
        {
            if (type is IAliasType alias && alias.BaseType is { } next) { type = next; continue; }
            if (type is IEnumType en) return (en.Name, Members(en));
            return (type.Name, null);
        }
        return ("?", null);
    }

    /// <summary>Maps PlcOpen time / date values (reported as raw integers) to TimeSpan / DateTime; everything else is returned unchanged.</summary>
    public static object? Normalize(string baseType, object? value) => (baseType.ToUpperInvariant(), value) switch
    {
        ("TIME" or "TOD" or "TIME_OF_DAY", uint ms) => TimeSpan.FromMilliseconds(ms),
        ("LTIME", ulong ns) => TimeSpan.FromTicks((long)(ns / 100)),
        ("DATE", uint s) => DateTime.UnixEpoch.AddSeconds(s),
        ("DT" or "DATE_AND_TIME", uint s) => DateTime.UnixEpoch.AddSeconds(s),
        _ => value,
    };

    private static IReadOnlyDictionary<long, string> Members(IEnumType en)
    {
        var map = new Dictionary<long, string>();
        foreach (var m in en.EnumValues)
            if (m.Primitive is { } p) map.TryAdd(System.Convert.ToInt64(p, System.Globalization.CultureInfo.InvariantCulture), m.Name);
        return map;
    }
}
