# Plan D: XAE Shell Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hidden XAE shell that shows a modal dialog makes the command fail with the dialog's text instead of hanging, and no shell started by iecode outlives it.

**Architecture:** The shell's process id comes from `DTE.MainWindow.HWnd`. A watcher scoped to that process replaces the global `FindWindow` of `DialogConfirmer`; the decision what to do with a dialog is a pure function in Core. A job object with kill-on-close ties the shell to the iecode process; a small registry of started shells in `%LOCALAPPDATA%\iecode\shells` backs `iecode shells list | kill`.

**Tech Stack:** C# .NET 10, xUnit v3, Win32 P/Invoke (`EnumWindows`, `GetWindowThreadProcessId`, `GetClassName`, `GetWindowText`, `EnumChildWindows`, `PostMessage`, `CreateJobObject`, `SetInformationJobObject`, `AssignProcessToJobObject`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 5; master plan [decisions 10 and 11](2026-11-24-cli-build-workflow-master-plan.md#decisions-planner-2026-11-24-the-user-delegated-every-decision).

## Eng review amendments (2026-11-24)

The [master plan table](2026-11-24-cli-build-workflow-master-plan.md#eng-review-amendments-2026-11-24) wins over the task text below:
- **Task 1 (R10):** `ShellEntry` gains `DateTime OwnerStartedUtc`; new `ShellRegistry.OwnerAlive(ShellEntry e, DateTime? ownerActualStartUtc)` with test `LiveOwnerIsSpared`.
- **Task 2 (R6, R7, R8, R27):** `DialogPolicy.Decide(SeenDialog d, int shellPid, bool userCanAnswer, DateTime nowUtc)`; `SeenDialog` gains `bool Visible, bool OwnerDisabled, DateTime? CancelSentUtc, DateTime? CloseSentUtc`. Actions: `None`, `ConfirmOk`, `Cancel` (modal and visible for 10 s), `Close` (5 s after Cancel), `GiveUp` (5 s after Close: the command fails and `Dispose` terminates the shell). `userCanAnswer` (with `--visible` or `--show-ui`) means `None` for unknown dialogs. Extra tests: `NoCancelWhenUserCanAnswer`, `InvisibleOrModelessIsIgnored`, `CloseAfterCancelHadNoEffect`, `GiveUpAfterClose`. A `COMException` from a shell call while `DialogWatch.Cancelled` is set becomes the dialog `IECodeException` (one helper in `XaeShell`). `Reporter.Line` and `Add` take a lock.
- **Task 3 (R9, R10, R11):** `shells kill` skips entries with a live owner unless `--force`; `Dispose` waits up to 30 s for the shell process to exit after `Quit`; manual step adds an `iecode activate` run that triggers "Potential symbol type change detected" and checks which process owns it.
- **Known limits (R29):** a dialog during `CreateInstance` (before the PID is known) is not watched.

## Global Constraints

See the [master plan](2026-11-24-cli-build-workflow-master-plan.md#global-constraints). Runs after Plan B (both edit `XaeShell.Build.cs`). Interop code is not unit-testable; every decision it makes goes through a Core function with tests.

## Review Focus

1. **A dialog of another program or another XAE shell** (a second iecode run, the user's own XAE): never touched, because the watcher only looks at windows of the recorded shell PID (Task 2 test `OtherProcessIsIgnored`). Today `DialogConfirmer` uses a global `FindWindow` by title and would press OK in another shell's dialog.
2. **The known "Potential symbol type change detected" dialog during activation**: still confirmed with OK, immediately, not cancelled after 10 s (Task 2 test `KnownTitleIsConfirmed`).
3. **A reused PID**: `shells kill` must not kill an unrelated process that got the PID of a dead shell; the registry entry stores the process start time and both must match (Task 1 test `ReusedPidIsStale`).
4. **Short progress windows** of the shell (status popups that close by themselves): not cancelled; only a dialog visible for 10 s in a row (Task 2 test `ShortDialogIsIgnored`).
5. **Job object assignment fails** (process already in a job that forbids nesting, access denied): the command continues with a `Detail` line; the registry entry still allows `shells kill` (Task 3 manual check, step 2).

---

### Task 1: `ShellRegistry` (Core)

**Files:**
- Create: `cli/src/IECode.Core/ShellRegistry.cs`
- Test: `cli/tests/IECode.Core.Tests/ShellRegistryTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record ShellEntry(int Pid, DateTime StartedUtc, int OwnerPid, string ProgId, string? Solution);`
  - `public sealed class ShellRegistry(string folder) { public void Add(ShellEntry e); public void Remove(int pid); public IReadOnlyList<ShellEntry> All(); public static string DefaultFolder(); }` (one JSON file `<pid>.json` per entry; `DefaultFolder` = `%LOCALAPPDATA%\iecode\shells`)
  - `public static bool ShellRegistry.IsSame(ShellEntry e, DateTime? actualStartUtc)` (true only when the process exists and its start time equals `StartedUtc` within 1 s)

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void AddListRemove()
{
    using var ws = new TempWorkspace();
    var r = new ShellRegistry(ws["shells"]);
    var e = new ShellEntry(1234, new DateTime(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc), 99, "TcXaeShell.DTE.15.0", @"C:\W\Machine.sln");
    r.Add(e);
    Assert.Equal(e, Assert.Single(r.All()));
    r.Remove(1234);
    Assert.Empty(r.All());
}

[Fact] public void BrokenFileIsSkipped() { /* write "{" into shells/5.json; All() returns the valid entries only */ }

[Fact] public void ReusedPidIsStale()
{
    var e = new ShellEntry(1234, new DateTime(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc), 99, "x", null);
    Assert.True(ShellRegistry.IsSame(e, e.StartedUtc.AddMilliseconds(400)));
    Assert.False(ShellRegistry.IsSame(e, e.StartedUtc.AddMinutes(5)));
    Assert.False(ShellRegistry.IsSame(e, null));
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ShellRegistryTests"`
Expected: build error.

- [ ] **Step 3: Implement** with `System.Text.Json` and `Reporter.JsonOptions`; writes go to a temp file and `File.Move(..., overwrite: true)`.

- [ ] **Step 4: Run to verify they pass.** Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/IECode.Core/ShellRegistry.cs cli/tests/IECode.Core.Tests/ShellRegistryTests.cs
git commit -s -m "Record the XAE shells iecode starts" -m "Killed runs left hidden shells behind and nobody could tell which ones were safe to end; the registry keeps PID and start time so only iecode's own shells are touched."
```

### Task 2: Dialog policy (Core) and the process-scoped watcher (Automation)

**Files:**
- Create: `cli/src/IECode.Core/DialogPolicy.cs`
- Create: `cli/src/IECode.Automation/Interop/DialogWatch.cs` (replaces `DialogConfirmer.cs`; delete that file and move `KnownTitles`)
- Modify: `cli/src/IECode.Automation/XaeShell.cs` (start the watch in `Start` after the PID is known, stop it in `Dispose`; `public string? BlockingDialog { get; }`), `XaeShell.Build.cs` and `XaeShell.Plc.cs` (after each COM call that may block and inside the wait loops: `ThrowIfDialogCancelled()`), `XaeShell.Plc.cs` `Activate` (no own confirmer any more)
- Test: `cli/tests/IECode.Core.Tests/DialogPolicyTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record SeenDialog(IntPtr Handle, int Pid, string ClassName, string Title, string Text, DateTime FirstSeenUtc);`
  - `public enum DialogAction { None, ConfirmOk, Cancel }`
  - `public static class DialogPolicy { public static readonly string[] KnownTitles = ["Potential symbol type change detected"]; public static readonly TimeSpan CancelAfter = TimeSpan.FromSeconds(10); public static DialogAction Decide(SeenDialog d, int shellPid, DateTime nowUtc); }`
  - Rules: other PID → `None`; title in `KnownTitles` → `ConfirmOk`; class `#32770` (standard dialog) visible for `>= CancelAfter` → `Cancel`; else `None`.
  - Automation: `internal sealed class DialogWatch : IDisposable { public static DialogWatch Start(int shellPid, Reporter log); public SeenDialog? Cancelled { get; } }` polls every 300 ms with `EnumWindows` filtered by `GetWindowThreadProcessId == shellPid`, reads static child texts with `EnumChildWindows` (class `Static`), acts per `DialogPolicy.Decide` (`PostMessage WM_COMMAND IDOK / IDCANCEL`), logs `Dialog "<title>" cancelled after 10 s: <text>`.

- [ ] **Step 1: Write the failing tests**

```csharp
static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);
static SeenDialog D(string title, int pid = 42, string cls = "#32770") => new(1, pid, cls, title, "text", T0);

[Fact] public void OtherProcessIsIgnored() => Assert.Equal(DialogAction.None, DialogPolicy.Decide(D("Save As", pid: 7), 42, T0.AddMinutes(1)));
[Fact] public void KnownTitleIsConfirmed() => Assert.Equal(DialogAction.ConfirmOk, DialogPolicy.Decide(D("Potential symbol type change detected"), 42, T0));
[Fact] public void ShortDialogIsIgnored() => Assert.Equal(DialogAction.None, DialogPolicy.Decide(D("Save As"), 42, T0.AddSeconds(9)));
[Fact] public void LongDialogIsCancelled() => Assert.Equal(DialogAction.Cancel, DialogPolicy.Decide(D("Save As"), 42, T0.AddSeconds(10)));
[Fact] public void NonDialogWindowIsIgnored() => Assert.Equal(DialogAction.None, DialogPolicy.Decide(D("Output", cls: "HwndWrapper"), 42, T0.AddMinutes(1)));
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*DialogPolicyTests"`
Expected: build error.

- [ ] **Step 3: Implement** `DialogPolicy`, then `DialogWatch`. Shell PID: `GetWindowThreadProcessId((IntPtr)(int)Dte.MainWindow.HWnd)` in `XaeShell.Start` right after `Configure()`; store as `public int? ProcessId`. When the PID cannot be read, log `Detail` and run without a watch. `ThrowIfDialogCancelled()` throws `IECodeException(ExitCodes.Failed, $"XAE showed a dialog and was stopped: {title}: {text}", "Run with --visible --show-ui to see and answer it.")`.

- [ ] **Step 4: Run to verify**

Run: the commands of step 2, then `dotnet build cli/IECode.slnx`. Expected: tests pass, solution builds.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git rm cli/src/IECode.Automation/Interop/DialogConfirmer.cs
git commit -s -m "Fail with the text of a dialog a hidden shell shows" -m "A hidden shell showed a Save As dialog for a long path and the build hung; the watcher now looks only at the shell's own windows, keeps confirming the known activation dialog, and cancels anything else after 10 s so the command can report it."
```

### Task 3: Job object and `iecode shells list | kill`

**Files:**
- Create: `cli/src/IECode.Automation/Interop/JobObject.cs`
- Modify: `cli/src/IECode.Automation/XaeShell.cs` (`Start`: register in `ShellRegistry`, assign to the job; `Dispose`: remove the entry)
- Create: `cli/src/IECode.Cli/Commands/ShellCommands.cs`; modify `Program.cs` to add it
- Test: none automated for the interop (Task 1 covers the registry); manual check in step 2.

**Interfaces:**
- Consumes: `ShellRegistry`, `ShellEntry`, `ShellRegistry.IsSame` (Task 1); `XaeShell.ProcessId` (Task 2).
- Produces: `internal static class JobObject { public static bool TryKillOnClose(int pid, Reporter log); }` (one process-wide job handle, created once, kept open for the process lifetime); CLI `iecode shells list` (entries whose process is alive and `IsSame`, plus stale ones marked `stale`, which are removed from the registry) and `iecode shells kill [--yes]` (asks, kills only `IsSame` entries, exit 0).

- [ ] **Step 1: Implement** `JobObject` (`CreateJobObject`, `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE)`, `AssignProcessToJobObject`), the registry calls and `ShellCommands`.
- [ ] **Step 2 (TwinCAT PC, 20 min):** start `iecode build <sln> --tc 4024`, kill the `iecode` process in Task Manager during the build. Expected: the `TcXaeShell` process ends within a few seconds. Then start a build, run `iecode shells list` in a second terminal: the shell is listed with its solution. If the job assignment failed (log line with `-v`), `iecode shells kill --yes` ends it.
- [ ] **Step 3:** Build the solution: `dotnet build cli/IECode.slnx`. Expected: no errors.
- [ ] **Step 4:** README (`shells list | kill` row), CHANGELOG line, commit:

```bash
git add cli/src cli/README.md extension/CHANGELOG.md
git commit -s -m "Tie the XAE shell to the iecode process" -m "The shell is a DCOM server, not a child process, so a killed iecode left it running; a kill-on-close job ends it with iecode, and shells list / kill cleans up what a failed job assignment leaves."
```

## Known limits

- Cancelling a dialog after 10 s ends that operation; there is no way to answer a dialog with anything but OK (known titles) or Cancel.
- Dialog texts are read from `Static` child controls; WPF dialogs of the shell may show an empty text (title only).
- If the shell PID cannot be read, there is neither a watch nor a job; the command behaves as today.
