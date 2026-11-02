namespace IECode.Core.Ads;

/// <summary>Classification of ADS error codes for the watch host. Pure, so it is unit-tested without a runtime.</summary>
public static class AdsCodes
{
    /// <summary>Target unreachable or port gone: 0x6 target port not found, 0x7 target machine not found, 0x745 timeout, 0x746..0x74A connection/port errors.</summary>
    public static bool IsConnectionLost(uint adsCode) => adsCode is 0x6 or 0x7 or 0x745 or (>= 0x746 and <= 0x74A);

    /// <summary>0x710 symbol not found, 0x711 symbol version invalid: handles must be resolved again.</summary>
    public static bool IsDeadHandle(uint adsCode) => adsCode is 0x710 or 0x711;
}
