using System.Runtime.Versioning;
using IECode.Core.Ads;
using TwinCAT.TypeSystem;

namespace IECode.Automation;

/// <summary>Bridges TwinCAT type information to <see cref="PlcValueText"/>: symbol lookup, alias resolution, enum members and PlcOpen date/time values.</summary>
[SupportedOSPlatform("windows")]
public static class AdsValues
{
    /// <summary>
    /// Finds a symbol by its full instance path. The loaded symbol collection only knows the first levels (MAIN.nCount),
    /// so deeper paths (MAIN.fbMotor.bEnable, GVL.aValues[3]) start at the longest known prefix and descend through the sub symbols.
    /// </summary>
    public static ISymbol? FindSymbol(ISymbolCollection<ISymbol> roots, string path)
    {
        if (roots.TryGetInstance(path, out var hit)) return hit;
        ISymbol? current = null;
        for (var i = path.Length - 1; i > 0 && current is null; i--)
            if (path[i] is '.' or '[' && roots.TryGetInstance(path[..i], out var prefix)) current = prefix;
        while (current is not null)
        {
            if (string.Equals(current.InstancePath, path, StringComparison.OrdinalIgnoreCase)) return current;
            ISymbol? next = null;
            foreach (var sub in current.SubSymbols)
            {
                var p = sub.InstancePath;
                if (path.StartsWith(p, StringComparison.OrdinalIgnoreCase) && (path.Length == p.Length || path[p.Length] is '.' or '['))
                {
                    next = sub;
                    break;
                }
            }
            current = next;
        }
        return null;
    }

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

    /// <summary>Maps PlcOpen time / date values (raw integers or TwinCAT.PlcOpen objects) to TimeSpan / DateTime; everything else is returned unchanged.</summary>
    public static object? Normalize(string baseType, object? value) => (baseType.ToUpperInvariant(), value) switch
    {
        (_, TwinCAT.PlcOpen.TimeBase t) => t.Time,
        (_, TwinCAT.PlcOpen.LTimeBase t) => t.Time,
        (_, TwinCAT.PlcOpen.DateBase d) => d.Value,
        ("TIME" or "TOD" or "TIME_OF_DAY", uint ms) => TimeSpan.FromMilliseconds(ms),
        ("LTIME", ulong ns) => TimeSpan.FromTicks((long)(ns / 100)),
        ("DATE", uint s) => DateTime.UnixEpoch.AddSeconds(s),
        ("DT" or "DATE_AND_TIME", uint s) => DateTime.UnixEpoch.AddSeconds(s),
        _ => value,
    };

    /// <summary>Converts text to the value to write into a variable of this type (enum member names and PlcOpen time / date values included).</summary>
    public static object ParseForWrite(IDataType? type, string text)
    {
        var (baseType, members) = Resolve(type);
        var value = PlcValueText.Parse(baseType, text, members);
        if (members is not null && type is not null) value = PlcValueText.Parse(EnumBaseType(type), System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)!);
        return value;
    }

    /// <summary>true if a variable of this type is one value (primitive, enum, string, subrange), false for structs, FBs, arrays, pointers, references, interfaces.</summary>
    public static bool IsSingleValue(IDataType? type)
    {
        while (type is IAliasType { BaseType: { } next }) type = next;
        return type?.Category is DataTypeCategory.Primitive or DataTypeCategory.Enum or DataTypeCategory.String or DataTypeCategory.SubRange;
    }

    /// <summary>Name of the integer type underlying an enum (INT if unknown), so a parsed enum number can be written.</summary>
    private static string EnumBaseType(IDataType type)
    {
        while (type is IAliasType { BaseType: { } next }) type = next;
        return type is IEnumType { BaseType: { } b } ? b.Name : "INT";
    }

    private static IReadOnlyDictionary<long, string> Members(IEnumType en)
    {
        var map = new Dictionary<long, string>();
        foreach (var m in en.EnumValues)
            if (m.Value is { } p) map.TryAdd(System.Convert.ToInt64(p, System.Globalization.CultureInfo.InvariantCulture), m.Name);
        return map;
    }
}
