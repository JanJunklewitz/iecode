// Developer tool: an in-process ADS server that forwards every request of the Beckhoff SDK to a real target and logs it
// (index group / offset / sizes / result). Use it where no packet capture is available, for example to count the ADS
// requests behind one SDK call or to read the raw error codes a PLC returns for a sum command.
//
//   dotnet run -- <rootSymbol> [amsNetId=127.0.0.1.1.1] [port=851]
//
// <rootSymbol> is a symbol of the target whose primitive members are used as test variables (for example "MAIN").
// The experiments only write the value a variable already has, so the target is left unchanged. Never add a request
// whose write length differs from the symbol size: the PLC does not check it and overwrites the memory behind it.
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.Server;
using TwinCAT.Ads.SumCommand;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;

if (args.Length < 1) { Console.WriteLine("usage: AdsTrace <rootSymbol> [amsNetId] [port]"); return 1; }
var root = args[0];
var netId = args.Length > 1 ? args[1] : "127.0.0.1.1.1";
var port = args.Length > 2 ? int.Parse(args[2]) : 851;
const ushort ProxyPort = 25001;

using var real = new AdsClient();
real.Connect(new AmsAddress(netId, port));
var proxy = new Proxy(ProxyPort, "adstrace", real);
var rc = proxy.ConnectServer();
Console.WriteLine($"proxy on port {ProxyPort}: {rc}, connected={proxy.IsConnected}");

var loader = (IAdsSymbolLoader)SymbolLoaderFactory.Create(real, new SymbolLoaderSettings(SymbolsLoadMode.VirtualTree));
var found = new List<IValueSymbol>();
void Walk(ISymbol s, int depth)
{
    if (depth > 6) return;
    foreach (var sub in s.SubSymbols)
    {
        if (sub.InstancePath.Contains(".P_") || sub.InstancePath.Contains("__")) continue;
        if (sub is IValueSymbol v && sub.DataType is { Category: DataTypeCategory.Primitive or DataTypeCategory.String }) found.Add(v);
        Walk(sub, depth + 1);
    }
}
Walk(loader.Symbols[root], 0);
static bool Readable(IValueSymbol v) { try { v.ReadValue(); return true; } catch { return false; } }
var pool = found.Where(s => !s.InstancePath.Contains(".ref") && Readable(s)).Take(1100).Cast<ISymbol>().ToList();
Console.WriteLine($"{pool.Count} readable variables below {root}");

using var viaProxy = new AdsClient();
viaProxy.Connect(new AmsAddress(netId, ProxyPort));
static string Codes(AdsErrorCode[]? a) => a == null ? "null" : a.Length + ":" + string.Join(",", a.GroupBy(x => x).Select(g => g.Key + "x" + g.Count()));

void Run(string name, IList<ISymbol> syms, SumFallbackMode mode)
{
    var vals = syms.Select(s => ((IValueSymbol)s).ReadValue()!).ToArray();
    proxy.Log.Clear();
    try
    {
        var w = new SumSymbolWrite(viaProxy, syms, mode);
        var r = w.Write(vals);
        Console.WriteLine($"{name}: result={r.ErrorCode} subs={Codes(r.SubErrors)} asSum={w.ExecutedAsSum} fallback={w.IsFallback} requests={proxy.Log.Count} [{string.Join("; ", proxy.Log.Take(6))}]");
    }
    catch (Exception e) { Console.WriteLine($"{name}: THROWS {e.GetType().Name}: {e.Message} requests={proxy.Log.Count}"); }
}

Console.WriteLine("--- request count per sum write (same-value writes)");
proxy.Mode = "pass";
foreach (var n in new[] { 3, 20, 200, 1000 }.Where(n => n <= pool.Count)) Run($"n={n}", pool.Take(n).ToList(), SumFallbackMode.Sum);

Console.WriteLine("--- target without sum support (proxy answers DeviceServiceNotSupported to the sum index groups)");
proxy.Mode = "nosum";
foreach (var m in new[] { SumFallbackMode.Sum, SumFallbackMode.All, SumFallbackMode.Discrete }) Run("nosum " + m, pool.Take(3).ToList(), m);
proxy.Mode = "pass";

Console.WriteLine("--- raw sub-codes of the target for the largest request (no SDK interpretation)");
var last = proxy.Captured.LastOrDefault(c => c.ig == 0xF081);
if (last.read != null)
{
    var count = (int)last.io;
    var raw = Enumerable.Range(0, count).Select(k => BitConverter.ToUInt32(last.read, k * 4)).Where(x => x != 0).GroupBy(x => x);
    Console.WriteLine($"{count} items, non-zero raw codes: {string.Join(", ", raw.Select(g => $"0x{g.Key:X} x{g.Count()}"))}");
}
return 0;

sealed class Proxy(ushort port, string name, AdsClient real) : AdsServer(port, name)
{
    public readonly List<string> Log = [];
    public readonly List<(uint ig, uint io, byte[] write, byte[] read, AdsErrorCode code)> Captured = [];
    /// <summary>"pass" forwards everything; "nosum" answers the sum index groups 0xF080-0xF084 with DeviceServiceNotSupported.</summary>
    public string Mode = "pass";

    protected override Task<ResultReadWriteBytes> OnReadWriteAsync(AmsAddress sender, uint invokeId, uint ig, uint io, int readLength, ReadOnlyMemory<byte> writeData, CancellationToken cancel)
    {
        if (Mode == "nosum" && ig >= 0xF080 && ig <= 0xF084)
        {
            Log.Add($"RW {ig:X}/{io} w={writeData.Length} -> refused");
            return Task.FromResult(new ResultReadWriteBytes(AdsErrorCode.DeviceServiceNotSupported, ReadOnlyMemory<byte>.Empty, invokeId));
        }
        var r = real.ReadWriteAsResult(ig, io, readLength, writeData);
        Log.Add($"RW {ig:X}/{io} w={writeData.Length} r={readLength} -> {r.ErrorCode}");
        Captured.Add((ig, io, writeData.ToArray(), r.Data.ToArray(), r.ErrorCode));
        return Task.FromResult(r);
    }

    protected override Task<ResultReadBytes> OnReadAsync(AmsAddress sender, uint invokeId, uint ig, uint io, int readLength, CancellationToken cancel)
    {
        var r = real.ReadAsResult(ig, io, readLength);
        Log.Add($"R {ig:X}/{io} len={readLength} -> {r.ErrorCode}");
        return Task.FromResult(r);
    }

    protected override Task<ResultWrite> OnWriteAsync(AmsAddress target, uint invokeId, uint ig, uint io, ReadOnlyMemory<byte> writeData, CancellationToken cancel)
    {
        var r = real.WriteAsResult(ig, io, writeData);
        Log.Add($"W {ig:X}/{io} w={writeData.Length} -> {r.ErrorCode}");
        return Task.FromResult(r);
    }
}
