namespace IECode.Core;

/// <summary>Process exit codes. Stable: scripts and the VS Code extension rely on them.</summary>
public static class ExitCodes
{
    public const int Ok = 0;
    public const int Failed = 1;
    public const int Usage = 2;
    public const int NotFound = 3;
    public const int BuildFailed = 10;
    public const int ActivationFailed = 11;
    public const int LibraryFailed = 12;
    public const int ProtectionFailed = 13;
    public const int UserManagementFailed = 14;
    public const int VersionNotInstalled = 15;
    public const int TargetFailed = 16;
    public const int Timeout = 17;
    public const int IoLinksChanged = 18;
    public const int NotSupportedPlatform = 20;
    public const int Cancelled = 130;
    public const int Unexpected = 99;
}

/// <summary>An expected failure with a user-facing message, an exit code and an optional hint.</summary>
public sealed class IECodeException(int exitCode, string message, string? hint = null, Exception? inner = null)
    : Exception(message, inner)
{
    public int ExitCode { get; } = exitCode;
    public string? Hint { get; } = hint;
}
