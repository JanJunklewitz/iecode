namespace IECode.Core;

/// <summary>
/// Object protection for one tree item, parsed from
/// <c>"&lt;item path&gt;[,encrypted=true|false][,signed=true|false][,level=&lt;name&gt;]"</c>.
/// The item path uses TwinCAT tree notation, e.g. <c>TIPC^PLC1^PLC1 Project^POUs</c>.
/// A bare last token without <c>=</c> is taken as the protection level.
/// </summary>
public sealed record ProtectionSpec(string ItemPath, bool? Encrypted, bool? Signed, string? Level)
{
    public static ProtectionSpec Parse(string text)
    {
        var parts = text.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0 || parts[0].Contains('='))
            throw Invalid(text, "The first part must be the item path.");

        bool? encrypted = null, signed = null;
        string? level = null;
        foreach (var part in parts.Skip(1))
        {
            var kv = part.Split('=', 2, StringSplitOptions.TrimEntries);
            if (kv.Length == 1)
            {
                level = level is null ? kv[0] : throw Invalid(text, "The protection level is given twice.");
                continue;
            }
            switch (kv[0].ToLowerInvariant())
            {
                case "encrypted" or "encrypt": encrypted = ParseBool(kv[1], text); break;
                case "signed" or "sign": signed = ParseBool(kv[1], text); break;
                case "level": level = kv[1]; break;
                default: throw Invalid(text, $"Unknown key '{kv[0]}'.");
            }
        }
        if (encrypted is null && signed is null && level is null)
            throw Invalid(text, "Nothing to change: add encrypted=, signed= or a protection level.");
        return new ProtectionSpec(parts[0], encrypted, signed, level);
    }

    private static bool ParseBool(string value, string text) =>
        bool.TryParse(value, out var b) ? b : throw Invalid(text, $"'{value}' is not true or false.");

    private static IECodeException Invalid(string text, string why) =>
        new(ExitCodes.Usage, $"Invalid protection spec '{text}'. {why}",
            "Example: \"TIPC^PLC1^PLC1 Project^POUs,encrypted=true,signed=true,level=Service\"");
}
