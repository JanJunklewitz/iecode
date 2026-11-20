namespace IECode.Automation;

/// <summary>
/// The system-info symbols the <c>state</c> op reads. The defaults are the documented names of the TwinCAT system-info list;
/// checked against a simulation on 2026-11-20 (all three resolve, <c>CycleTime</c> 120000 for a 12 ms task, so the unit is 100 ns).
/// A differing name only changes this record; the counters that do not resolve come back as a note, never as a failure.
/// <c>CycleTime</c> is in units of 100 ns.
/// </summary>
internal sealed record PlcStateNames(Func<int, string> CycleCount, Func<int, string> CycleTime, string OnlineChange)
{
    public static readonly PlcStateNames Default = new(
        task => $"TwinCAT_SystemInfoVarList._TaskInfo[{task}].CycleCount",
        task => $"TwinCAT_SystemInfoVarList._TaskInfo[{task}].CycleTime",
        "TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt");
}
