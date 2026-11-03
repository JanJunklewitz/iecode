using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class AdsCodesTests
{
    [Fact]
    public void AdsCodes_ConnectionLost_AndDeadHandle()
    {
        foreach (var c in new uint[] { 0x6, 0x7, 0x1A, 0x1B, 0x1D, 0x1F, 0x745, 0x746, 0x74A })
        {
            Assert.True(AdsCodes.IsConnectionLost(c));
            Assert.False(AdsCodes.IsDeadHandle(c));
        }
        foreach (var c in new uint[] { 0x710, 0x711 })
        {
            Assert.True(AdsCodes.IsDeadHandle(c));
            Assert.False(AdsCodes.IsConnectionLost(c));
        }
        foreach (var c in new uint[] { 0x705, 0x701, 0x1C, 0x1E })
        {
            Assert.False(AdsCodes.IsConnectionLost(c));
            Assert.False(AdsCodes.IsDeadHandle(c));
        }
    }
}
