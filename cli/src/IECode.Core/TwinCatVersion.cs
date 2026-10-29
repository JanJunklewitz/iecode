using System.Text.RegularExpressions;

namespace IECode.Core;

/// <summary>
/// A TwinCAT version request as typed by the user: <c>4024</c>, <c>4024.66</c>, <c>3.1.4024.66</c> or <c>auto</c>.
/// Resolved against the versions installed on the machine.
/// </summary>
public sealed partial record TwinCatVersion(int? Build, int? Revision)
{
    public static readonly TwinCatVersion Auto = new(null, null);

    public bool IsAuto => Build is null;

    /// <summary>Major line, e.g. 4024 or 4026. Decides which XAE shell is used.</summary>
    public int? Line => Build;

    [GeneratedRegex(@"^(?:3\.1\.)?(?<build>\d{4})(?:\.(?<rev>\d+))?$")]
    private static partial Regex Pattern();

    public static TwinCatVersion Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Equals("auto", StringComparison.OrdinalIgnoreCase)) return Auto;
        var m = Pattern().Match(text.Trim());
        if (!m.Success)
            throw new IECodeException(ExitCodes.Usage, $"Invalid TwinCAT version '{text}'.",
                "Use 4024, 4026, an exact build like 4024.66 or 3.1.4024.66, or auto.");
        return new TwinCatVersion(int.Parse(m.Groups["build"].Value),
            m.Groups["rev"].Success ? int.Parse(m.Groups["rev"].Value) : null);
    }

    /// <summary>True if a full installed version string like <c>3.1.4024.66</c> satisfies this request.</summary>
    public bool Matches(string installed)
    {
        if (IsAuto) return true;
        var v = Parse(installed);
        return v.Build == Build && (Revision is null || v.Revision == Revision);
    }

    /// <summary>Picks the newest installed version that satisfies the request, or null.</summary>
    public string? Resolve(IEnumerable<string> installed) =>
        installed.Where(i => Pattern().IsMatch(i) && Matches(i))
                 .OrderByDescending(i => Parse(i).Build)
                 .ThenByDescending(i => Parse(i).Revision ?? -1)
                 .FirstOrDefault();

    /// <summary>
    /// Picks the RepTool profile for a version. Profiles are named "TwinCAT PLC Control_Build_&lt;build&gt;.&lt;rev&gt;";
    /// the newest one matching the request wins. Falls back to the default profile "TwinCAT PLC Control".
    /// </summary>
    public static string PickRepToolProfile(IEnumerable<string> profileNames, TwinCatVersion version)
    {
        const string prefix = "TwinCAT PLC Control_Build_";
        return profileNames
            .Where(n => n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            .Select(n => (Name: n, Build: n[prefix.Length..]))
            .Where(p => Pattern().IsMatch(p.Build) && version.Matches(p.Build))
            .OrderByDescending(p => Parse(p.Build).Build)
            .ThenByDescending(p => Parse(p.Build).Revision ?? -1)
            .Select(p => p.Name)
            .FirstOrDefault() ?? "TwinCAT PLC Control";
    }

    /// <summary>
    /// Profile name of a file in a RepTool <c>Profiles</c> folder: "&lt;name&gt;.profile" (4024) or "&lt;name&gt;.profile.xml"
    /// (4026); null for other files.
    /// </summary>
    public static string? RepToolProfileName(string fileName) =>
        fileName.EndsWith(".profile.xml", StringComparison.OrdinalIgnoreCase) ? fileName[..^".profile.xml".Length]
        : fileName.EndsWith(".profile", StringComparison.OrdinalIgnoreCase) ? fileName[..^".profile".Length]
        : null;

    public override string ToString() => IsAuto ? "auto" : Revision is null ? $"3.1.{Build}" : $"3.1.{Build}.{Revision}";
}
