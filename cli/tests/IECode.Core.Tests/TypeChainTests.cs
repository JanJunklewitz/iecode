using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class TypeChainTests
{
    /// <summary>Stand-in for a TwinCAT data type: Beckhoff's EnumType is an enum and an alias of its base integer at once.</summary>
    private sealed record T(string Name, bool IsEnum = false, T? AliasOf = null)
    {
        public T? Alias { get; set; } = AliasOf;
    }

    private static T? Underlying(T? t) => TypeChain.Underlying(t, x => x.IsEnum, x => x.Alias);

    [Fact]
    public void Enum_ThatIsAlsoAnAlias_StopsAtTheEnum()
    {
        var e = new T("E_Mode", IsEnum: true, AliasOf: new T("INT"));
        Assert.Same(e, Underlying(e));
    }

    [Fact]
    public void AliasOfAnEnum_ResolvesToTheEnum()
    {
        var e = new T("E_Mode", IsEnum: true, AliasOf: new T("INT"));
        Assert.Same(e, Underlying(new T("T_Mode", AliasOf: new T("T_Inner", AliasOf: e))));
    }

    [Fact]
    public void AliasChain_ResolvesToTheBaseType()
    {
        var i = new T("INT");
        Assert.Same(i, Underlying(new T("T_Count", AliasOf: new T("T_Inner", AliasOf: i))));
    }

    [Fact]
    public void Null_AndCycles_GiveNull()
    {
        Assert.Null(Underlying(null));
        var a = new T("A");
        var b = new T("B", AliasOf: a);
        a.Alias = b;
        Assert.Null(Underlying(a));
    }
}
