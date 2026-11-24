namespace IECode.Core;

/// <summary>A top-level window as the dialog watcher read it in one poll.</summary>
/// <param name="OwnerDisabled">The window has an owner and that owner is disabled: the window is modal.</param>
/// <param name="Progress">The window has a progress bar: a progress window of a running operation, never cancelled.</param>
public sealed record WindowSnapshot(nint Handle, int Pid, string ClassName, string Title, string Text, bool Visible, bool OwnerDisabled, bool Progress = false);

/// <summary>
/// A window the watcher follows: when it was first seen as a visible modal window in a row, and when Cancel and
/// WM_CLOSE were sent to it.
/// </summary>
public sealed record SeenDialog(nint Handle, int Pid, string ClassName, string Title, string Text, DateTime FirstSeenUtc,
    bool Visible, bool OwnerDisabled, DateTime? CancelSentUtc, DateTime? CloseSentUtc, bool Progress = false);

/// <summary>How long an unknown modal dialog may stay before Cancel, and before each next step; tests shorten them.</summary>
public sealed record DialogTimings(TimeSpan CancelAfter, TimeSpan EscalateAfter)
{
    public static readonly DialogTimings Default = new(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(5));
}

public enum DialogAction
{
    None,
    /// <summary>A known dialog: answer it with OK (keeps today's handling).</summary>
    ConfirmOk,
    /// <summary>An unknown modal dialog visible for <see cref="DialogTimings.CancelAfter"/>: press Cancel.</summary>
    Cancel,
    /// <summary>Cancel had no effect: send WM_CLOSE.</summary>
    Close,
    /// <summary>WM_CLOSE had no effect either: the shell is hung; fail the command and end the shell.</summary>
    GiveUp,
}

/// <summary>
/// What the dialog watcher does with a window of the XAE shell. A blocked COM call returns only when the modal
/// dialog closes, so an unattended run must close unknown dialogs itself to fail with their text instead of hanging.
/// </summary>
public static class DialogPolicy
{
    /// <summary>Titles confirmed with OK. Confirming keeps the mapping information on type changes. English XAE titles only so far.</summary>
    public static readonly string[] KnownTitles = ["Potential symbol type change detected"];

    /// <summary>Process names of XAE shells (TwinCAT 4024, 4026, Visual Studio). Their dialogs are never touched unless the shell is the one iecode started.</summary>
    public static readonly string[] ShellProcessNames = ["TcXaeShell", "TcXaeShell64", "devenv"];

    public static bool IsShellProcess(string processName) => ShellProcessNames.Contains(processName, StringComparer.OrdinalIgnoreCase);

    /// <summary>The standard dialog class (message boxes, Save As, …).</summary>
    public const string DialogClass = "#32770";

    /// <param name="shellPid">The owned shell process; null when it is not known: then only known titles, of any process (today's activation handling).</param>
    /// <param name="userCanAnswer">The shell is visible (<c>--visible</c> or <c>--show-ui</c>): unknown dialogs are left to the user.</param>
    public static DialogAction Decide(SeenDialog d, int? shellPid, bool userCanAnswer, DateTime nowUtc, DialogTimings? timings = null)
    {
        var (cancelAfter, escalateAfter) = timings ?? DialogTimings.Default;
        if (shellPid is { } pid && d.Pid != pid) return DialogAction.None;
        if (KnownTitles.Contains(d.Title, StringComparer.Ordinal)) return DialogAction.ConfirmOk;
        if (shellPid is null || userCanAnswer) return DialogAction.None;
        if (d.ClassName != DialogClass || !d.Visible || !d.OwnerDisabled || d.Progress) return DialogAction.None;
        if (d.CloseSentUtc is { } close) return nowUtc - close >= escalateAfter ? DialogAction.GiveUp : DialogAction.None;
        if (d.CancelSentUtc is { } cancel) return nowUtc - cancel >= escalateAfter ? DialogAction.Close : DialogAction.None;
        return nowUtc - d.FirstSeenUtc >= cancelAfter ? DialogAction.Cancel : DialogAction.None;
    }

    /// <summary>The error a command fails with after the watcher cancelled a dialog (or gave up and ended the shell).</summary>
    public static IECodeException Failure(SeenDialog d, bool gaveUp, Exception? inner = null)
    {
        var what = d.Text.Length == 0 ? d.Title : $"{d.Title}: {d.Text}";
        return new IECodeException(ExitCodes.Failed,
            gaveUp ? $"XAE showed a dialog that did not close and the shell was ended: {what}" : $"XAE showed a dialog and was stopped: {what}",
            "Run with --visible --show-ui to see and answer it.", inner);
    }
}

/// <summary>
/// The dialog watcher's memory between polls: which windows are visible modal dialogs since when, what was sent to
/// them, and the first dialog that made the command fail. Not thread-safe: one watcher thread calls it.
/// </summary>
public sealed class DialogTracker(int? shellPid, bool userCanAnswer, DialogTimings? timings = null)
{
    private readonly Dictionary<nint, SeenDialog> _seen = [];

    /// <summary>The first dialog that was cancelled; the command fails with it.</summary>
    public SeenDialog? Cancelled { get; private set; }

    /// <summary>A dialog did not close after Cancel and WM_CLOSE; the shell is hung. No further actions.</summary>
    public bool GaveUp { get; private set; }

    /// <summary>Takes one poll's windows and returns what to do with each; records Cancel and Close as sent.</summary>
    public IReadOnlyList<(SeenDialog Dialog, DialogAction Action)> Next(IEnumerable<WindowSnapshot> windows, DateTime nowUtc)
    {
        var actions = new List<(SeenDialog, DialogAction)>();
        var present = new HashSet<nint>();
        foreach (var w in windows)
        {
            present.Add(w.Handle);
            var modal = w.Visible && w.OwnerDisabled;
            var d = _seen.TryGetValue(w.Handle, out var old) && modal && old.Visible && old.OwnerDisabled && old.Pid == w.Pid && old.ClassName == w.ClassName && old.Title == w.Title
                ? old with { Text = w.Text.Length > 0 ? w.Text : old.Text, Progress = w.Progress }
                : new SeenDialog(w.Handle, w.Pid, w.ClassName, w.Title, w.Text, nowUtc, w.Visible, w.OwnerDisabled, null, null, w.Progress);
            if (GaveUp) { _seen[w.Handle] = d; continue; }

            var action = DialogPolicy.Decide(d, shellPid, userCanAnswer, nowUtc, timings);
            if (action == DialogAction.Cancel) { d = d with { CancelSentUtc = nowUtc }; Cancelled ??= d; }
            else if (action == DialogAction.Close) d = d with { CloseSentUtc = nowUtc };
            else if (action == DialogAction.GiveUp) { GaveUp = true; Cancelled = d; }
            _seen[w.Handle] = d;
            if (action != DialogAction.None) actions.Add((d, action));
        }
        foreach (var gone in _seen.Keys.Where(h => !present.Contains(h)).ToList()) _seen.Remove(gone);
        return actions;
    }
}
