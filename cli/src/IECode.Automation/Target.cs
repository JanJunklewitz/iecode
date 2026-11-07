using System.Runtime.Versioning;
using IECode.Core;
using IECode.Core.Ads;
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;
using AdsNetId = TwinCAT.Ads.AmsNetId;

namespace IECode.Automation;

/// <summary>TwinCAT runtime state of a target as reported by the system service.</summary>
public sealed record TargetState(string NetId, string State, short DeviceState);

/// <summary>Talks to a TwinCAT runtime over ADS: system state, run/config mode, PLC variables. Needs an ADS route to the target.</summary>
[SupportedOSPlatform("windows")]
public static class Target
{
    private const int SystemServicePort = 10000;

    public static TargetState State(Core.AmsNetId target)
    {
        using var client = Connect(target, SystemServicePort);
        var info = Try(() => client.ReadState(), target);
        return new TargetState(target.ToString(), info.AdsState.ToString(), info.DeviceState);
    }

    /// <summary>Switches the runtime to run mode (restart) or config mode.</summary>
    public static void SetMode(Core.AmsNetId target, bool run)
    {
        using var client = Connect(target, SystemServicePort);
        var state = run ? AdsState.Reset : AdsState.Reconfig;
        Try(() => { client.WriteControl(new StateInfo(state, 0)); return 0; }, target);
    }

    /// <summary>Reads a PLC variable by its full symbol name, e.g. MAIN.bStart or GVL.nCount. Value is the raw value as read, Text is the canonical text.</summary>
    public static (string Type, object? Value, string Text) Read(Core.AmsNetId target, int port, string symbol)
    {
        using var client = Connect(target, port);
        var sym = FindSymbol(client, symbol, target);
        var (baseType, members) = AdsValues.Resolve(sym.DataType);
        var value = Try(() => sym.ReadValue(), target);
        return (sym.DataType?.Name ?? "?", value, PlcValueText.Format(baseType, AdsValues.Normalize(baseType, value), members));
    }

    /// <summary>Writes a PLC variable. The text is converted to the variable's type (enum member names and PlcOpen time / date values included).</summary>
    public static (object Value, string Text) Write(Core.AmsNetId target, int port, string symbol, string text)
    {
        using var client = Connect(target, port);
        var sym = FindSymbol(client, symbol, target);
        var (baseType, members) = AdsValues.Resolve(sym.DataType);
        var value = AdsValues.ParseForWrite(sym.DataType, text);
        Try(() => { sym.WriteValue(value); return 0; }, target);
        return (value, PlcValueText.Format(baseType, value, members));
    }

    private static AdsClient Connect(Core.AmsNetId target, int port)
    {
        var client = new AdsClient();
        try
        {
            client.Connect(new AdsNetId(target.ToString()), port);
            return client;
        }
        catch (Exception e)
        {
            client.Dispose();
            throw Unreachable(target, e);
        }
    }

    private static IValueSymbol FindSymbol(AdsClient client, string symbol, Core.AmsNetId target)
    {
        var loader = Try(() => SymbolLoaderFactory.Create(client, SymbolLoaderSettings.Default), target);
        return Try(() => AdsValues.FindSymbol(loader.Symbols, symbol), target) as IValueSymbol
            ?? throw new IECodeException(ExitCodes.NotFound, $"Symbol '{symbol}' not found on {target}.",
                "Use the full instance path, e.g. MAIN.fbMotor.bEnable or GVL.nCount, and check the ADS port (--port, default 851). " + AdsCodes.HiddenHint);
    }

    private static T Try<T>(Func<T> call, Core.AmsNetId target)
    {
        try { return call(); }
        catch (AdsErrorException e) { throw new IECodeException(ExitCodes.TargetFailed, $"ADS error from {target}: {e.ErrorCode} ({e.Message})", inner: e); }
        catch (AdsException e) { throw Unreachable(target, e); }
    }

    private static IECodeException Unreachable(Core.AmsNetId target, Exception e) =>
        new(ExitCodes.TargetFailed, $"Cannot reach {target} over ADS: {e.Message}",
            "Check that TwinCAT runs on this PC and that an ADS route to the target exists.", e);
}
