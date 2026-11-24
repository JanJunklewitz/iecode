namespace IECode.Core.Tests;

public class DialogPolicyTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);
    private const string Known = "Potential symbol type change detected";

    private static SeenDialog D(string title, int pid = 42, string cls = "#32770", bool visible = true, bool ownerDisabled = true,
        DateTime? cancelSent = null, DateTime? closeSent = null) =>
        new(1, pid, cls, title, "text", T0, visible, ownerDisabled, cancelSent, closeSent);

    private static DialogAction Decide(SeenDialog d, DateTime now, bool userCanAnswer = false, int? shellPid = 42) =>
        DialogPolicy.Decide(d, shellPid, userCanAnswer, now);

    [Fact] public void OtherProcessIsIgnored() => Assert.Equal(DialogAction.None, Decide(D("Save As", pid: 7), T0.AddMinutes(1)));
    [Fact] public void OtherProcessWithTheKnownTitleIsIgnored() => Assert.Equal(DialogAction.None, Decide(D(Known, pid: 7), T0));
    [Fact] public void KnownTitleIsConfirmed() => Assert.Equal(DialogAction.ConfirmOk, Decide(D(Known), T0));
    [Fact] public void KnownTitleIsConfirmedAlsoWhenTheUserCouldAnswer() => Assert.Equal(DialogAction.ConfirmOk, Decide(D(Known), T0, userCanAnswer: true));
    [Fact] public void ShortDialogIsIgnored() => Assert.Equal(DialogAction.None, Decide(D("Save As"), T0.AddSeconds(9)));
    [Fact] public void LongDialogIsCancelled() => Assert.Equal(DialogAction.Cancel, Decide(D("Save As"), T0.AddSeconds(10)));
    [Fact] public void NonDialogWindowIsIgnored() => Assert.Equal(DialogAction.None, Decide(D("Output", cls: "HwndWrapper"), T0.AddMinutes(1)));
    [Fact] public void NoCancelWhenUserCanAnswer() => Assert.Equal(DialogAction.None, Decide(D("Save As"), T0.AddMinutes(1), userCanAnswer: true));

    [Fact]
    public void InvisibleOrModelessIsIgnored()
    {
        Assert.Equal(DialogAction.None, Decide(D("Save As", visible: false), T0.AddMinutes(1)));
        Assert.Equal(DialogAction.None, Decide(D("Save As", ownerDisabled: false), T0.AddMinutes(1)));
    }

    [Fact]
    public void CloseAfterCancelHadNoEffect()
    {
        var d = D("Save As", cancelSent: T0.AddSeconds(10));
        Assert.Equal(DialogAction.None, Decide(d, T0.AddSeconds(14)));
        Assert.Equal(DialogAction.Close, Decide(d, T0.AddSeconds(15)));
    }

    [Fact]
    public void GiveUpAfterClose()
    {
        var d = D("Save As", cancelSent: T0.AddSeconds(10), closeSent: T0.AddSeconds(15));
        Assert.Equal(DialogAction.None, Decide(d, T0.AddSeconds(19)));
        Assert.Equal(DialogAction.GiveUp, Decide(d, T0.AddSeconds(20)));
    }

    [Fact]
    public void WithoutAnOwnedShellOnlyKnownTitlesOfAnyProcess()
    {
        Assert.Equal(DialogAction.ConfirmOk, Decide(D(Known, pid: 7), T0, shellPid: null));
        Assert.Equal(DialogAction.None, Decide(D("Save As", pid: 7), T0.AddMinutes(1), shellPid: null));
    }

    [Fact]
    public void FailureCarriesTitleAndText()
    {
        var d = new SeenDialog(1, 42, "#32770", "Save As", "The path is too long.", T0, true, true, null, null);
        var cancelled = DialogPolicy.Failure(d, gaveUp: false);
        Assert.Equal(ExitCodes.Failed, cancelled.ExitCode);
        Assert.Equal("XAE showed a dialog and was stopped: Save As: The path is too long.", cancelled.Message);
        Assert.Contains("--visible --show-ui", cancelled.Hint);

        var ended = DialogPolicy.Failure(d with { Text = "" }, gaveUp: true);
        Assert.Equal("XAE showed a dialog that did not close and the shell was ended: Save As", ended.Message);
    }
}

public class DialogTrackerTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);
    private static WindowSnapshot W(nint h = 1, string title = "Save As", int pid = 42, bool visible = true) =>
        new(h, pid, "#32770", title, "too long", visible, OwnerDisabled: true);

    private static DialogAction Only(IReadOnlyList<(SeenDialog Dialog, DialogAction Action)> r) => r.Count == 0 ? DialogAction.None : Assert.Single(r).Action;

    [Fact]
    public void EscalatesCancelCloseGiveUp()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0)));
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0.AddSeconds(9))));
        Assert.Equal(DialogAction.Cancel, Only(t.Next([W()], T0.AddSeconds(10))));
        Assert.Equal("Save As", t.Cancelled?.Title);
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0.AddSeconds(12))));
        Assert.Equal(DialogAction.Close, Only(t.Next([W()], T0.AddSeconds(15))));
        Assert.Equal(DialogAction.GiveUp, Only(t.Next([W()], T0.AddSeconds(20))));
        Assert.True(t.GaveUp);
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0.AddSeconds(30))));
    }

    [Fact]
    public void AWindowThatGoesAwayStartsAgain()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        t.Next([W()], T0);
        t.Next([], T0.AddSeconds(5));
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0.AddSeconds(11))));
        Assert.Equal(DialogAction.Cancel, Only(t.Next([W()], T0.AddSeconds(21))));
    }

    [Fact]
    public void AReusedHandleWithAnotherTitleStartsAgain()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        t.Next([W()], T0);
        Assert.Equal(DialogAction.None, Only(t.Next([W(title: "Other")], T0.AddSeconds(11))));
    }

    [Fact]
    public void HiddenTimeDoesNotCount()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        t.Next([W(visible: false)], T0);
        Assert.Equal(DialogAction.None, Only(t.Next([W()], T0.AddSeconds(11))));
        Assert.Equal(DialogAction.Cancel, Only(t.Next([W()], T0.AddSeconds(21))));
    }

    [Fact]
    public void TheFirstCancelledDialogIsKept()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        t.Next([W(1, "First"), W(2, "Second")], T0);
        t.Next([W(1, "First")], T0.AddSeconds(10));
        t.Next([W(2, "Second")], T0.AddSeconds(11));
        Assert.Equal("First", t.Cancelled?.Title);
    }

    [Fact]
    public void KnownTitleIsConfirmedEveryPollUntilItCloses()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        var known = W(title: DialogPolicy.KnownTitles[0]);
        Assert.Equal(DialogAction.ConfirmOk, Only(t.Next([known], T0)));
        Assert.Equal(DialogAction.ConfirmOk, Only(t.Next([known], T0.AddSeconds(1))));
        Assert.Null(t.Cancelled);
    }
}

public class DialogTimingTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ShorterTimingsEscalateSooner()
    {
        var t = new DialogTracker(42, userCanAnswer: false, new DialogTimings(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1)));
        var w = new WindowSnapshot(1, 42, "#32770", "Save As", "", true, true);
        t.Next([w], T0);
        Assert.Equal(DialogAction.Cancel, Assert.Single(t.Next([w], T0.AddSeconds(1))).Action);
        Assert.Equal(DialogAction.Close, Assert.Single(t.Next([w], T0.AddSeconds(2))).Action);
        Assert.Equal(DialogAction.GiveUp, Assert.Single(t.Next([w], T0.AddSeconds(3))).Action);
    }
}

public class ShellStartTests
{
    [Fact] public void ExactlyOneNewProcessIsOwned() => Assert.Equal(30, ShellRegistry.Started([10, 20], [10, 20, 30]));
    [Fact] public void TwoNewProcessesAreNotOwned() => Assert.Null(ShellRegistry.Started([10], [10, 30, 40]));
    [Fact] public void NoNewProcessIsNotOwned() => Assert.Null(ShellRegistry.Started([10, 20], [20]));
}

public class DialogReviewFixTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ProgressDialogIsIgnored()
    {
        var d = new SeenDialog(1, 42, "#32770", "Activating", "", T0, true, true, null, null, Progress: true);
        Assert.Equal(DialogAction.None, DialogPolicy.Decide(d, 42, false, T0.AddMinutes(5)));
    }

    [Fact]
    public void TrackerPassesTheProgressFlagOn()
    {
        var t = new DialogTracker(42, userCanAnswer: false);
        var w = new WindowSnapshot(1, 42, "#32770", "Activating", "", true, true, Progress: true);
        t.Next([w], T0);
        Assert.Empty(t.Next([w], T0.AddMinutes(1)));
    }

    [Theory]
    [InlineData("TcXaeShell", true)]
    [InlineData("tcxaeshell64", true)]
    [InlineData("devenv", true)]
    [InlineData("TcSysUi", false)]
    [InlineData("powershell", false)]
    public void ShellProcessNames(string name, bool shell) => Assert.Equal(shell, DialogPolicy.IsShellProcess(name));
}

public class DialogTitleTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void GermanTitleOfTheActivationDialogIsConfirmed()
    {
        // TwinCAT 4026 with German resources (TwinCAT System ManagerUI.dll, 1031) translates the title; 4024 keeps the English one
        var d = new SeenDialog(1, 42, "#32770", "Mögliche Typänderung des Symbols erkannt", "", T0, true, true, null, null);
        Assert.Equal(DialogAction.ConfirmOk, DialogPolicy.Decide(d, 42, false, T0));
    }
}
