using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class PlcValueTextTests
{
    [Theory]
    [InlineData("BOOL", true, "TRUE")]
    [InlineData("INT", (short)-42, "-42")]
    [InlineData("REAL", 3.14f, "3.14")]
    [InlineData("LREAL", 0.1, "0.1")]
    [InlineData("STRING(80)", "Hello, world", "Hello, world")]
    public void Format_Elementary(string type, object value, string expected) => Assert.Equal(expected, PlcValueText.Format(type, value));

    [Fact] public void Format_Time() => Assert.Equal("00:00:01.5000000", PlcValueText.Format("TIME", TimeSpan.FromMilliseconds(1500)));
    [Fact] public void Format_Dt() => Assert.Equal("2026-11-02T13:05:09", PlcValueText.Format("DT", new DateTime(2026, 11, 2, 13, 5, 9)));
    [Fact] public void Format_Date() => Assert.Equal("2026-11-02", PlcValueText.Format("DATE", new DateTime(2026, 11, 2)));
    [Fact] public void Format_Enum_UnknownValue_IsNumber() => Assert.Equal("7", PlcValueText.Format("E_State", 7, new Dictionary<long, string> { [0] = "Idle" }));
    [Fact] public void Format_Enum_KnownValue_IsName() => Assert.Equal("Idle", PlcValueText.Format("E_State", (short)0, new Dictionary<long, string> { [0] = "Idle" }));
    [Fact] public void Parse_Enum_ByName() => Assert.Equal(1L, System.Convert.ToInt64(PlcValueText.Parse("E_State", "Running", new Dictionary<long, string> { [0] = "Idle", [1] = "Running" })));
    [Fact] public void Parse_Enum_ByNumber() => Assert.Equal(1L, System.Convert.ToInt64(PlcValueText.Parse("E_State", "1", new Dictionary<long, string> { [1] = "Running" })));
    [Fact] public void Parse_Enum_ByName_IgnoresCase() => Assert.Equal(1L, System.Convert.ToInt64(PlcValueText.Parse("E_State", "running", new Dictionary<long, string> { [0] = "Idle", [1] = "Running" })));
    [Fact] public void Parse_Enum_ExactCaseWins() => Assert.Equal(2L, System.Convert.ToInt64(PlcValueText.Parse("E_State", "RUN", new Dictionary<long, string> { [1] = "Run", [2] = "RUN" })));
    [Fact] public void Parse_Enum_AmbiguousCase_IsUsageError() => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => PlcValueText.Parse("E_State", "run", new Dictionary<long, string> { [1] = "Run", [2] = "RUN" })).ExitCode);
    [Fact] public void Parse_Bool_Variants() { Assert.Equal(true, PlcValueText.Parse("BOOL", "true")); Assert.Equal(false, PlcValueText.Parse("BOOL", "0")); }
    [Fact] public void Parse_Time() => Assert.Equal(TimeSpan.FromMilliseconds(1500), PlcValueText.Parse("TIME", "00:00:01.5000000"));
    [Fact] public void Parse_Real_RejectsDecimalComma() => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => PlcValueText.Parse("REAL", "1,5")).ExitCode);
    [Fact] public void Parse_Int_Overflow_IsUsageError() => Assert.Throws<IECodeException>(() => PlcValueText.Parse("SINT", "200"));
    [Fact] public void RoundTrip_Lreal() { var t = PlcValueText.Format("LREAL", 1.0 / 3); Assert.Equal(1.0 / 3, (double)PlcValueText.Parse("LREAL", t)); }
    [Fact] public void Parse_Struct_NotSupported() => Assert.Throws<IECodeException>(() => PlcValueText.Parse("ST_Motor", "1"));

    [Theory]
    [InlineData("BOOL", false, true)]
    [InlineData("DINT", false, true)]
    [InlineData("LREAL", false, true)]
    [InlineData("TIME", false, true)]
    [InlineData("LTIME", false, true)]
    [InlineData("E_State", true, true)]
    [InlineData("STRING(80)", false, false)]
    [InlineData("DT", false, false)]
    [InlineData("ST_Motor", false, false)]
    public void IsNumeric(string type, bool isEnum, bool expected) => Assert.Equal(expected, PlcValueText.IsNumeric(type, isEnum));
}
