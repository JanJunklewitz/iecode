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
            return OnlineSymbols.Select(set.Enumerate(), filter);
        }
        catch (Exception e) when (e is AdsException or IOException or System.Net.Sockets.SocketException)
        {
            throw new IECodeException(ExitCodes.TargetFailed, $"Cannot reach {where} over ADS: {e.Message}");
        }
    }
}
