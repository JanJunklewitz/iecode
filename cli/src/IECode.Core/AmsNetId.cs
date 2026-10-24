using System.Globalization;

namespace IECode.Core;

/// <summary>ADS address of a TwinCAT system, six bytes like <c>5.80.201.232.1.1</c>.</summary>
public readonly record struct AmsNetId(byte B0, byte B1, byte B2, byte B3, byte B4, byte B5)
{
    /// <summary>The local TwinCAT system.</summary>
    public static readonly AmsNetId Local = new(127, 0, 0, 1, 1, 1);

    public bool IsLocal => this == Local;

    /// <summary>Accepts <c>a.b.c.d.e.f</c> or <c>local</c>.</summary>
    public static bool TryParse(string? text, out AmsNetId id)
    {
        id = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        text = text.Trim();
        if (text.Equals("local", StringComparison.OrdinalIgnoreCase) || text.Equals("<local>", StringComparison.OrdinalIgnoreCase))
        {
            id = Local;
            return true;
        }
        var parts = text.Split('.');
        if (parts.Length != 6) return false;
        var b = new byte[6];
        for (var i = 0; i < 6; i++)
            if (!byte.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out b[i])) return false;
        id = new AmsNetId(b[0], b[1], b[2], b[3], b[4], b[5]);
        return true;
    }

    public static AmsNetId Parse(string text) =>
        TryParse(text, out var id)
            ? id
            : throw new IECodeException(ExitCodes.Usage, $"Invalid AMS NetId '{text}'.", "Use six numbers like 5.80.201.232.1.1, or 'local'.");

    public override string ToString() => $"{B0}.{B1}.{B2}.{B3}.{B4}.{B5}";
}
