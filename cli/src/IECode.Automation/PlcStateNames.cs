namespace IECode.Automation;

/// <summary>
/// The system-info symbols the <c>state</c> op reads. UNVERIFIED: the defaults are the documented names of the TwinCAT system-info
/// list and were not checked against a PLC (the plan step needs a simulation). A differing name only changes this record; the
/// counters that do not resolve come back as a note, never as a failure.
/// <c>CycleTime</c> is in units of 100 ns.
/// </summary>
internal sealed record PlcStateNames(Func<int, string> CycleCount, Func<int, string> CycleTime, string OnlineChange)
{
    public static readonly PlcStateNames Default = new(
        task => $"TwinCAT_SystemInfoVarList._TaskInfo[{task}].CycleCount",
        task => $"TwinCAT_SystemInfoVarList._TaskInfo[{task}].CycleTime",
        "TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt");
}
