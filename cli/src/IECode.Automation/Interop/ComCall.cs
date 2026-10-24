using System.Collections;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace IECode.Automation.Interop;

/// <summary>Helpers for late-bound COM objects (EnvDTE and the TwinCAT Automation Interface via IDispatch).</summary>
[SupportedOSPlatform("windows")]
internal static class ComCall
{
    // HRESULTs that mean "the XAE shell is busy, try again".
    private const int RPC_E_CALL_REJECTED = unchecked((int)0x80010001);
    private const int RPC_E_SERVERCALL_RETRYLATER = unchecked((int)0x8001010A);
    private const int RPC_S_CALL_FAILED = unchecked((int)0x800706BE);
    private const int RPC_E_SYS_CALL_FAILED = unchecked((int)0x80010100);

    public static bool IsBusy(COMException e) =>
        e.HResult is RPC_E_CALL_REJECTED or RPC_E_SERVERCALL_RETRYLATER or RPC_S_CALL_FAILED or RPC_E_SYS_CALL_FAILED;

    /// <summary>Runs a COM call and retries while the shell reports it is busy.</summary>
    public static T Retry<T>(Func<T> call, int attempts = 20, int delayMs = 500)
    {
        for (var i = 1; ; i++)
        {
            try { return call(); }
            catch (COMException e) when (IsBusy(e) && i < attempts) { Thread.Sleep(delayMs); }
        }
    }

    public static void Retry(Action call, int attempts = 20, int delayMs = 500) =>
        Retry<object?>(() => { call(); return null; }, attempts, delayMs);

    /// <summary>
    /// Enumerates a COM collection. DTE and TwinCAT collections are 1-based (Count + Item(i));
    /// SAFEARRAYs arrive as object[]; anything else is tried as IEnumerable.
    /// </summary>
    public static IEnumerable<dynamic> Items(object? source)
    {
        if (source is null) yield break;
        dynamic collection = source;
        if (source is object[] array)
        {
            foreach (var x in array) yield return x;
            yield break;
        }
        int count;
        try { count = (int)collection.Count; }
        catch (Exception) { count = -1; }
        if (count >= 0)
        {
            for (var i = 1; i <= count; i++) yield return collection.Item(i);
            yield break;
        }
        if (source is IEnumerable e)
            foreach (var x in e) yield return x!;
    }

    /// <summary>Children of a TwinCAT tree item (ITcSmTreeItem: ChildCount + Child(i), 1-based).</summary>
    public static IEnumerable<dynamic> Children(object source)
    {
        dynamic treeItem = source;
        int count = Retry(() => (int)treeItem.ChildCount);
        for (var i = 1; i <= count; i++) yield return Retry(() => treeItem.Child(i));
    }

    public static void Release(object? o)
    {
        if (o is not null && Marshal.IsComObject(o)) Marshal.FinalReleaseComObject(o);
    }
}
