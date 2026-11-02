using System.Globalization;

namespace IECode.Core.Ads;

/// <summary>
/// Canonical text form of PLC values, shared by the CLI (ads read/write) and the watchlist host.
/// Aliases are resolved by the caller; this class only sees base type names.
/// </summary>
public static class PlcValueText
{
    private const string DateTimeFormat = "yyyy-MM-dd'T'HH:mm:ss";
    private const string DateFormat = "yyyy-MM-dd";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>.NET value as read over ADS -> canonical text. enumMembers: value -> name for enum types, else null.</summary>
    public static string Format(string iecType, object? value, IReadOnlyDictionary<long, string>? enumMembers = null)
    {
        if (value is null) return "";
        if (enumMembers is not null)
        {
            var n = ToInt64(value);
            return n is { } l && enumMembers.TryGetValue(l, out var name) ? name : Invariant(value);
        }
        var t = iecType.ToUpperInvariant();
        return value switch
        {
            bool b => b ? "TRUE" : "FALSE",
            TimeSpan ts => ts.ToString("c", Inv),
            DateTime dt => dt.ToString(t == "DATE" ? DateFormat : DateTimeFormat, Inv),
            float f => f.ToString("R", Inv),
            double d => d.ToString("R", Inv),
            string s => s,
            _ => Invariant(value),
        };
    }

    /// <summary>canonical / user text -> .NET value of the IEC type. Throws IECodeException(ExitCodes.Usage, ...) on bad input.</summary>
    public static object Parse(string iecType, string text, IReadOnlyDictionary<long, string>? enumMembers = null)
    {
        var t = iecType.ToUpperInvariant();
        try
        {
            if (enumMembers is not null) return ParseEnum(text, enumMembers);
            return t switch
            {
                "BOOL" => text.Trim().ToUpperInvariant() switch { "TRUE" or "1" => true, "FALSE" or "0" => false, _ => throw new FormatException() },
                "BYTE" or "USINT" => byte.Parse(text, Inv),
                "SINT" => sbyte.Parse(text, Inv),
                "WORD" or "UINT" => ushort.Parse(text, Inv),
                "INT" => short.Parse(text, Inv),
                "DWORD" or "UDINT" => uint.Parse(text, Inv),
                "DINT" => int.Parse(text, Inv),
                "LWORD" or "ULINT" => ulong.Parse(text, Inv),
                "LINT" => long.Parse(text, Inv),
                "REAL" => float.Parse(text, NumberStyles.Float, Inv),
                "LREAL" => double.Parse(text, NumberStyles.Float, Inv),
                "TIME" or "LTIME" or "TOD" or "TIME_OF_DAY" => TimeSpan.ParseExact(text.Trim(), "c", Inv),
                "DATE" => DateTime.ParseExact(text.Trim(), DateFormat, Inv),
                "DT" or "DATE_AND_TIME" => DateTime.ParseExact(text.Trim(), DateTimeFormat, Inv),
                _ when t.StartsWith("STRING", StringComparison.Ordinal) || t.StartsWith("WSTRING", StringComparison.Ordinal) => text,
                _ => throw new IECodeException(ExitCodes.Usage, $"Values of type {iecType} are not supported.",
                    "Supported: BOOL, integer types, REAL, LREAL, STRING, WSTRING, enums, TIME, LTIME, TOD, DATE, DT."),
            };
        }
        catch (Exception e) when (e is FormatException or OverflowException)
        {
            throw new IECodeException(ExitCodes.Usage, $"'{text}' is not a valid {iecType}.");
        }
    }

    /// <summary>true for BOOL, integer types, REAL, LREAL, enums (enumMembers != null), TIME, LTIME - the values the scope can plot.</summary>
    public static bool IsNumeric(string iecType, bool isEnum) => isEnum || iecType.ToUpperInvariant() is
        "BOOL" or "BYTE" or "USINT" or "SINT" or "WORD" or "UINT" or "INT" or "DWORD" or "UDINT" or "DINT"
        or "LWORD" or "ULINT" or "LINT" or "REAL" or "LREAL" or "TIME" or "LTIME";

    private static object ParseEnum(string text, IReadOnlyDictionary<long, string> members)
    {
        var s = text.Trim();
        foreach (var (value, name) in members)
            if (string.Equals(name, s, StringComparison.Ordinal)) return value;
        return long.Parse(s, Inv);
    }

    private static long? ToInt64(object value)
    {
        try { return value is Enum ? Convert.ToInt64(value, Inv) : value is IConvertible and not string ? Convert.ToInt64(value, Inv) : null; }
        catch (Exception e) when (e is OverflowException or InvalidCastException or FormatException) { return null; }
    }

    private static string Invariant(object value) => value is IFormattable f ? f.ToString(null, Inv) : value.ToString() ?? "";
}
