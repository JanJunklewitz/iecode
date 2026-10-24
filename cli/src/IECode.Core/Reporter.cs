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
    private bool _color = !Console.IsOutputRedirected && Environment.GetEnvironmentVariable("NO_COLOR") is null;

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

    public void Add(Diagnostic d)
    {
        _diagnostics.Add(d);
        if (Json) return;
        var where = d.File is null ? "" : $"{Path.GetFileName(d.File)}{(d.Line is null ? "" : $"({d.Line}{(d.Column is null ? "" : $",{d.Column}")})")}  ";
        var text = $"{(d.Code is null ? "" : d.Code + "  ")}{where}{d.Message}";
        if (d.Severity == Severity.Error) Line(_err, "  ✖ " + text, "\e[31m");
        else if (d.Severity == Severity.Warning) Line(_err, "  ⚠ " + text, "\e[33m");
        else Detail(text);
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
    public void Finish(string command, int exitCode, object? data, string? error = null, string? hint = null)
    {
        if (!Json) return;
        var doc = new Result(
            Command: command,
            Ok: exitCode == 0,
            ExitCode: exitCode,
            DurationMs: _clock.ElapsedMilliseconds,
            TwinCat: TwinCatVersion,
            Data: data,
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
