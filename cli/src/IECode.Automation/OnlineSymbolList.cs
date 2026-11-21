using System.Runtime.Versioning;
using IECode.Core;
using IECode.Core.Ads;
using TwinCAT;
using TwinCAT.Ads;

namespace IECode.Automation;

/// <summary>
/// The symbols of a running PLC by filter. A short-lived call of its own: the full upload of the symbol table is slow and
/// would stall the samples, waits and confirmed writes of the watch host if it ran there.
/// </summary>
[SupportedOSPlatform("windows")]
public static class OnlineSymbolList
{
    public static (IReadOnlyList<OnlineSymbol> Matches, int Total) List(Core.AmsNetId target, int port, string filter)
    {
        var resolved = LocalTarget.Resolve(target);
        return List(() => new BeckhoffLink(resolved, port), $"{resolved}:{port}", filter);
    }

    internal static (IReadOnlyList<OnlineSymbol> Matches, int Total) List(Func<IAdsLink> newLink, string where, string filter)
    {
        using var link = newLink();
        try
        {
            link.Connect();
            var state = link.ReadState();
            if (state != AdsErrorCode.NoError)
                throw new IECodeException(ExitCodes.TargetFailed, $"Cannot reach {where} over ADS: {state} (0x{(uint)state:X})");
            var set = link.UploadSymbols();
            // A running PLC always has symbols: an empty table means the connection is gone.
            if (SymbolTable.MeansUnreachable(1, set.Count))
                throw new IECodeException(ExitCodes.TargetFailed, $"Cannot reach {where} over ADS: empty symbol table, the target does not answer");
            return OnlineSymbols.Select(WithMembersBelow(set, filter), filter);
        }
        catch (Exception e) when (e is AdsException or IOException or System.Net.Sockets.SocketException)
        {
            throw new IECodeException(ExitCodes.TargetFailed, $"Cannot reach {where} over ADS: {e.Message}");
        }
    }

    private const int MaxBelowDepth = 8;

    /// <summary>
    /// The enumerated table plus, for a filter that names a path ("MAIN.fbMT.stCmp.stSetMan." or "...stSetMan.eSel"), the members
    /// below that path. The table walk does not reach every nested member, but a lookup by path does (it is what a read uses).
    /// </summary>
    private static IEnumerable<OnlineSymbol> WithMembersBelow(ISymbolSet set, string filter)
    {
        var all = set.Enumerate();
        var dot = filter.LastIndexOf('.');
        if (dot <= 0) return all;
        var parent = set.Find(filter[..dot]);
        if (parent is null || parent.Kind != Core.Ads.NodeKind.Struct) return all;
        var below = new List<OnlineSymbol>();
        Collect(parent, 1, below);
        return all.Concat(below).DistinctBy(s => s.Name, StringComparer.OrdinalIgnoreCase);
    }

    private static void Collect(ILinkSymbol node, int depth, List<OnlineSymbol> into)
    {
        foreach (var child in node.Children)
        {
            into.Add(new OnlineSymbol(child.Path, child.TypeName, null));
            if (depth < MaxBelowDepth && child.Kind == Core.Ads.NodeKind.Struct) Collect(child, depth + 1, into);
        }
    }
}
