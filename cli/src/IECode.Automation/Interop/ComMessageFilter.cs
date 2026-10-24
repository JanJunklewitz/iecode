using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace IECode.Automation.Interop;

/// <summary>
/// OLE message filter: when the XAE shell is busy it rejects incoming COM calls
/// (RPC_E_CALL_REJECTED). Registering a filter on the calling STA thread makes COM retry
/// those calls automatically instead of throwing. Must be registered on an STA thread.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class ComMessageFilter : IOleMessageFilter, IDisposable
{
    private const int SERVERCALL_ISHANDLED = 0;
    private const int PENDINGMSG_WAITDEFPROCESS = 2;
    private const int SERVERCALL_RETRYLATER = 2;
    private const int RetryAfterMs = 150;
    private const int GiveUpAfterMs = 120_000;

    private readonly IOleMessageFilter? _previous;

    private ComMessageFilter()
    {
        CoRegisterMessageFilter(this, out _previous);
    }

    public static ComMessageFilter Register()
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
            throw new InvalidOperationException("The COM message filter needs an STA thread.");
        return new ComMessageFilter();
    }

    public void Dispose() => CoRegisterMessageFilter(_previous, out _);

    int IOleMessageFilter.HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo) =>
        SERVERCALL_ISHANDLED;

    int IOleMessageFilter.RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType) =>
        dwRejectType == SERVERCALL_RETRYLATER && dwTickCount < GiveUpAfterMs ? RetryAfterMs : -1;

    int IOleMessageFilter.MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType) =>
        PENDINGMSG_WAITDEFPROCESS;

    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(IOleMessageFilter? newFilter, out IOleMessageFilter? oldFilter);
}

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IOleMessageFilter
{
    [PreserveSig] int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);
    [PreserveSig] int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
}
