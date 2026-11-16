using System.Text.RegularExpressions;

namespace IECode.Core.Ads;

/// <summary>Classification of ADS error codes for the watch host. Pure, so it is unit-tested without a runtime.</summary>
public static class AdsCodes
{
    /// <summary>
    /// Target unreachable or port gone: 0x6 target port not found, 0x7 target machine not found, the router transport
    /// codes 0x1A TCP send error, 0x1B host unreachable, 0x1D TLS send error (Secure ADS route) and 0x1F TCP connection
    /// refused, 0x745 timeout, 0x746..0x74A connection/port errors.
    /// </summary>
    public static bool IsConnectionLost(uint adsCode) =>
        adsCode is 0x6 or 0x7 or 0x1A or 0x1B or 0x1D or 0x1F or 0x745 or (>= 0x746 and <= 0x74A);

    /// <summary>0x710 symbol not found, 0x711 symbol version invalid: handles must be resolved again.</summary>
    public static bool IsDeadHandle(uint adsCode) => adsCode is 0x710 or 0x711;

    /// <summary>
    /// Appended to "symbol not found": a variable with {attribute 'hide'} exists in the program but has no ADS symbol, which
    /// looks like a typo to the reader (often an AI agent) unless it is said.
    /// </summary>
    public const string HiddenHint = "If the variable has {attribute 'hide'}, it has no ADS symbol: read it through a property with {attribute 'monitoring' := 'call'}.";

    /// <summary>The error of a watched item whose name is not in the symbol table.</summary>
    public const string SymbolNotFound = "Symbol not found. " + HiddenHint;

    /// <summary>
    /// The text appended to "symbol not found". For a path with array indexes it names the declared bounds of the first array whose
    /// index lies outside them (else of the first array), so an index error is not mistaken for {attribute 'hide'}; otherwise it is
    /// <see cref="HiddenHint"/>. <paramref name="typeNameOf"/> gives the type name of a symbol path, null when it does not exist.
    /// </summary>
    public static string NotFoundHint(string symbol, Func<string, string?> typeNameOf)
    {
        string? firstArray = null;
        for (var open = symbol.IndexOf('['); open >= 0; open = symbol.IndexOf('[', open + 1))
        {
            var close = symbol.IndexOf(']', open);
            if (close < 0) break;
            var prefix = symbol[..open];
            var typeName = typeNameOf(prefix);
            if (typeName is null || !typeName.StartsWith("ARRAY", StringComparison.OrdinalIgnoreCase)) continue;
            firstArray ??= $"'{prefix}' is {typeName}.";

            var bounds = Regex.Match(typeName, @"^ARRAY\s*\[([^\]]*)\]", RegexOptions.IgnoreCase);
            if (!bounds.Success) continue;
            var dims = bounds.Groups[1].Value.Split(',');
            var indexes = symbol[(open + 1)..close].Split(',');
            for (var d = 0; d < Math.Min(dims.Length, indexes.Length); d++)
            {
                var range = dims[d].Split("..", StringSplitOptions.TrimEntries);
                if (range.Length == 2 && long.TryParse(range[0], out var lo) && long.TryParse(range[1], out var hi)
                    && long.TryParse(indexes[d].Trim(), out var index) && (index < lo || index > hi))
                    return $"'{prefix}' is {typeName}: index {index} is outside {lo}..{hi}.";
            }
        }
        return firstArray ?? HiddenHint;
    }
}
