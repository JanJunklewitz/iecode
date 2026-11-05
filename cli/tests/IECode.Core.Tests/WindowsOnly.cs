namespace IECode.Core.Tests;

/// <summary>Skip condition for tests of Windows-only behavior (drive letters, junctions, the \.\pipe\ directory).</summary>
public static class WindowsOnly
{
    public static bool IsWindows => OperatingSystem.IsWindows();
}
