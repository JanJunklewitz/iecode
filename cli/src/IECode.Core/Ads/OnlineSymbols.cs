namespace IECode.Core.Ads;

/// <summary>One symbol of the symbol table of a running PLC.</summary>
public sealed record OnlineSymbol(string Name, string Type, string? Comment);

/// <summary>Filtering and capping of the online symbol list; the table of a running PLC is far too large to hand out whole.</summary>
public static class OnlineSymbols
{
    public const int MaxMatches = 500;

    /// <summary>Case-insensitive "name contains filter", sorted by name (ordinal, ignoring case); the total is counted before the cap.</summary>
    public static (IReadOnlyList<OnlineSymbol> Matches, int Total) Select(IEnumerable<OnlineSymbol> all, string filter, int max = MaxMatches)
    {
        var matches = all.Where(s => s.Name.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return (matches.Take(max).ToList(), matches.Count);
    }

    /// <summary>The trimmed filter; a blank one is refused because listing the whole table would flood the caller.</summary>
    public static string RequireFilter(string? filter)
    {
        var f = filter?.Trim();
        if (string.IsNullOrEmpty(f))
            throw new IECodeException(ExitCodes.Usage, "--online needs --filter: the symbol table of a running PLC is too large to list.");
        return f;
    }
}
