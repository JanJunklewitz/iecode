using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace IECode.Core;

/// <summary>
/// All console output goes through here. Human mode prints readable lines to stderr/stdout;
/// JSON mode stays silent until the end and prints exactly one JSON document to stdout.
/// </summary>
public sealed class Reporter(bool json, bool verbose, TextWriter? stdout = null, TextWriter? stderr = null)
{
    private readonly TextWriter _out = stdout ?? Console.Out;
    private readonly TextWriter _err = stderr ?? Console.Error;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<Diagnostic> _diagnostics = [];
    private readonly List<string> _messages = [];
    // ConsoleVt last: it switches the Windows console into ANSI mode, and only matters when colors are wanted.
    // Without that mode (old conhost), colors and the overwriting status line are dropped instead of printed raw.
    private bool _color = !Console.IsOutputRedirected && Environment.GetEnvironmentVariable("NO_COLOR") is null && ConsoleVt.IsAvailable;

    // IECODE_PROGRESS=1: in JSON mode also echo progress lines to stderr (used by the VS Code extension).
    private readonly bool _progress = Environment.GetEnvironmentVariable("IECODE_PROGRESS") == "1";

    public bool Json { get; } = json;
    public bool Verbose { get; } = verbose;
    public string? TwinCatVersion { get; set; }
    public IReadOnlyList<Diagnostic> Diagnostics => _diagnostics;

    public void Step(string text) => Line(_err, "● " + text, "\e[2m");
    public void Info(string text) => Line(_out, text, null);
    public void Detail(string text) { if (Verbose) Line(_err, "  " + text, "\e[2m"); }
    public void Success(string text) => Line(_out, "✔ " + text, "\e[32m");
    public void Warn(string text) => Line(_err, "⚠ " + text, "\e[33m");
    public void Error(string text) => Line(_err, "✖ " + text, "\e[31m");

    /// <summary>Shows a status line that is overwritten by the next one (human mode, interactive only).</summary>
    public void Status(string text)
    {
        if (Json || !_color) return;
        _err.Write("\r\e[2K\e[2m  " + Truncate(text, Math.Max(20, SafeWidth() - 4)) + "\e[0m");
    }

    public void ClearStatus()
    {
        if (!Json && _color) _err.Write("\r\e[2K");
    }

    /// <summary>Errors (and, counted separately, warnings) printed per build in human mode; 0 = all. JSON always has all.</summary>
    public int MaxErrors { get; set; } = DefaultMaxErrors(Console.IsErrorRedirected);

    /// <summary>50 on a console; unlimited when stderr goes to a file, so a log keeps every line for grep.</summary>
    public static int DefaultMaxErrors(bool errorRedirected) => errorRedirected ? 0 : 50;

    private int _printedErrors, _printedWarnings, _hiddenErrors, _hiddenWarnings;

    /// <summary>Starts the print limit anew: each build of a command gets its own <see cref="MaxErrors"/>.</summary>
    public void BeginBuild() => _printedErrors = _printedWarnings = _hiddenErrors = _hiddenWarnings = 0;

    /// <summary>Applied to every diagnostic before it is recorded or printed, e.g. to point paths of an isolated copy back at the source.</summary>
    public Func<Diagnostic, Diagnostic>? MapDiagnostic { get; set; }

    private Diagnostic Mapped(Diagnostic d) => MapDiagnostic is { } map ? map(d) : d;

    public void Add(Diagnostic d)
    {
        d = Mapped(d);
        _diagnostics.Add(d);
        if (Json) return;
        if (d.Severity == Severity.Error && !Within(ref _printedErrors, ref _hiddenErrors)) return;
        if (d.Severity == Severity.Warning && !Within(ref _printedWarnings, ref _hiddenWarnings)) return;
        Print(d);
    }

    private bool Within(ref int printed, ref int hidden)
    {
        if (MaxErrors > 0 && printed >= MaxErrors) { hidden++; return false; }
        printed++;
        return true;
    }

    private void Print(Diagnostic d)
    {
        var where = d.File is null ? "" : $"{Path.GetFileName(d.File)}{(d.Line is null ? "" : $"({d.Line}{(d.Column is null ? "" : $",{d.Column}")})")}  ";
        var text = $"{(d.Code is null ? "" : d.Code + "  ")}{where}{d.Message}";
        if (d.Severity == Severity.Error) Line(_err, "  ✖ " + text, "\e[31m");
        else if (d.Severity == Severity.Warning) Line(_err, "  ⚠ " + text, "\e[33m");
        else Detail(text);
    }

    /// <summary>
    /// Records and prints the diagnostics of one build: root causes first (always, whatever the limit), then the
    /// other messages up to <see cref="MaxErrors"/>, then follow-up counts per library and what was not shown.
    /// </summary>
    public void Report(Triage t, bool failed)
    {
        BeginBuild();
        if (!Json && t.RootCauses.Count > 0)
        {
            Line(_err, "Root causes:", "\e[31m");
            foreach (var d in t.RootCauses) Print(Mapped(d));
        }
        foreach (var d in t.All)
        {
            if (d.RootCause == true) _diagnostics.Add(Mapped(d));
            else Add(d);
        }
        if (Json) return;

        if (t.RootCauses.Count > 0 && t.FollowUps.Count > 0)
        {
            Line(_err, "Follow-up errors:", null);
            foreach (var g in t.FollowUps) Line(_err, $"  {g.Errors,4}  {g.Key}", null);
        }
        if (_hiddenErrors > 0) Line(_err, $"{_hiddenErrors} more error(s) not shown (--max-errors 0 shows all)", "\e[2m");
        if (_hiddenWarnings > 0) Line(_err, $"{_hiddenWarnings} more warning(s) not shown (--max-errors 0 shows all)", "\e[2m");
        if (t.StaticAnalysisOnly)
        {
            var codes = t.All.Where(d => d.Severity == Severity.Error).Select(d => d.Code!).Distinct().Order(StringComparer.Ordinal);
            Line(_err, $"Build failed only on static analysis: {t.Errors} finding(s) ({string.Join(", ", codes)}).", "\e[33m");
        }
        if (failed && t.Errors == 0) Line(_err, "No compiler errors; see the shell output (-v).", "\e[33m");
    }

    /// <summary>Asks a yes/no question. Non-interactive or JSON mode never assumes yes.</summary>
    public bool Confirm(string question, bool assumeYes)
    {
        if (assumeYes) return true;
        if (Json || Console.IsInputRedirected)
            throw new IECodeException(ExitCodes.Cancelled, $"{question} Confirmation needed.", "Pass --yes to confirm in scripts and CI.");
        _err.Write($"? {question} (y/N) ");
        var answer = Console.ReadLine()?.Trim();
        return answer is not null && (answer.Equals("y", StringComparison.OrdinalIgnoreCase) || answer.Equals("yes", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Writes the final JSON document (JSON mode only).</summary>
    /// <summary>
    /// Data a command records while it runs (e.g. the files a build changed), so that a failure or break-off still reports
    /// it: the error result carries it when it has no data of its own.
    /// </summary>
    public object? PartialData { get; set; }

    public void Finish(string command, int exitCode, object? data, string? error = null, string? hint = null)
    {
        if (!Json) return;
        var doc = new Result(
            Command: command,
            Ok: exitCode == 0,
            ExitCode: exitCode,
            DurationMs: _clock.ElapsedMilliseconds,
            TwinCat: TwinCatVersion,
            Data: data ?? (error is not null ? PartialData : null),
            Diagnostics: _diagnostics,
            Messages: _messages,
            Error: error,
            Hint: hint);
        _out.WriteLine(JsonSerializer.Serialize(doc, JsonOptions));
    }

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        WriteIndented = false,
    };

    private sealed record Result(
        string Command, bool Ok, int ExitCode, long DurationMs, string? TwinCat,
        object? Data, IReadOnlyList<Diagnostic> Diagnostics, IReadOnlyList<string> Messages,
        string? Error, string? Hint);

    private void Line(TextWriter w, string text, string? color)
    {
        if (Json)
        {
            _messages.Add(text);
            if (_progress) _err.WriteLine(text);
            return;
        }
        ClearStatus();
        w.WriteLine(_color && color is not null ? color + text + "\e[0m" : text);
    }

    private static int SafeWidth()
    {
        try { return Console.WindowWidth; } catch { return 100; }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    /// <summary>Disables ANSI colors (e.g. --no-color).</summary>
    public void DisableColor() => _color = false;
}
