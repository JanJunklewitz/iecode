using System.Text.RegularExpressions;

namespace IECode.Core.Projects;

/// <summary>How a library is referenced in a <c>.plcproj</c>.</summary>
public enum ReferenceKind
{
    /// <summary><c>PlaceholderReference</c>: resolved through a placeholder (the usual case).</summary>
    Placeholder,
    /// <summary><c>LibraryReference</c>: a library referenced directly with a fixed name.</summary>
    Library,
}

/// <summary>A library resolution string as TwinCAT writes it: <c>Tc2_Standard, 3.3.3.0 (Beckhoff Automation GmbH)</c>.</summary>
public sealed partial record LibraryId(string Name, string Version, string Vendor)
{
    /// <summary>True if the version is <c>*</c> (always newest installed).</summary>
    public bool IsNewest => Version == "*";

    [GeneratedRegex(@"^\s*(?<name>[^,]+?)\s*,\s*(?<ver>\S+)\s*\((?<vendor>[^)]+)\)\s*$")]
    private static partial Regex Pattern();

    public static bool TryParse(string? text, out LibraryId id)
    {
        id = null!;
        var m = text is null ? null : Pattern().Match(text);
        if (m is null || !m.Success) return false;
        id = new LibraryId(m.Groups["name"].Value, m.Groups["ver"].Value, m.Groups["vendor"].Value.Trim());
        return true;
    }

    public override string ToString() => $"{Name}, {Version} ({Vendor})";
}

/// <summary>One library reference of a PLC project with the version that actually applies.</summary>
public sealed record LibraryReference(
    string Placeholder,
    ReferenceKind Kind,
    LibraryId Default,
    LibraryId? PinnedResolution)
{
    /// <summary>What TwinCAT uses: a <c>PlaceholderResolution</c> if present, otherwise the default resolution.</summary>
    public LibraryId Effective => PinnedResolution ?? Default;

    /// <summary>True if the reference resolves to one fixed version (reproducible builds).</summary>
    public bool IsPinned => !Effective.IsNewest;
}
