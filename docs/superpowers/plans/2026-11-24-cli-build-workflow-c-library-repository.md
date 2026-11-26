# Plan C: Library Repository Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Writes to the library repository never overlap, and the library commands cover the bulk cases of a migration (several libraries per `lib update`, one version of many libraries per `lib uninstall`, filters, visible `*` resolution).

**Architecture:** `RepositoryLock` (Core) wraps every repository write. `LibrarySelection` (Core) holds the name and vendor matching and the update request parsing. `LibraryCommands` only wires them.

**Tech Stack:** C# .NET 10, xUnit v3, `System.Threading.Mutex`.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) sections 2, 6, 7 and answers Q4, Q5; master plan [decisions 8 and 9](2026-11-24-cli-build-workflow-master-plan.md#decisions-planner-2026-11-24-the-user-delegated-every-decision).

## Eng review amendments (2026-11-24)

The [master plan table](2026-11-24-cli-build-workflow-master-plan.md#eng-review-amendments-2026-11-24) wins over the task text below:
- **Task 1 (R12):** every XAE save that installs (`lib save --install`, `lib save-all --install`, `ws build`, `ws release`) calls `SaveAsLibrary(..., install: false)` and then `RepTool.Install(file, overwrite: true)` inside the lock, so the install always runs in a fresh process. The lock covers only the RepTool call. `AbandonedLockIsAcquired` runs on Windows only (`WindowsOnly.IsWindows`).
- **Task 2 (R22, R23):** JSON keeps `library` / `version` (first item) and always adds `items`. Without `--lib`, `--vendor` needs `--to latest` (newest per library); `--vendor X --to 1.2.0.0` without `--lib` is exit 2. Test `VendorWithFixedVersionIsAUsageError`; the existing test `VendorWithoutLibTakesAllReferencedLibrariesOfThatVendor` uses `--to latest`.
- **Task 3 (R26):** `uninstall --all` prints the repository folder it read the names from.
- **Task 4 (R24, R26):** the `dist/` default also applies to `encrypt --compiled-library`; update its `--out` help. `*` resolution and the stray warning use `RepositoryPath` (one repository, as `lib outdated`), not the merged scan.

**Second opinion (R34, R41, R43, R44):** RepTool gets the build `TcLineGuard` chose, `RepTool.Run` honours `--timeout` and kills its child, the lock file records the RepTool PID and an acquirer of an abandoned lock waits for it, `uninstall --all` needs `--repository` when several repositories exist; Task 1 install switch only after Plan B; Windows-only two-process lock tests with a handshake; `lib update` validates all items before the first write, `--from-project` with `name=version` is exit 2; drop the stray rule (show "highest installed: x"), drop R24 (`encrypt` keeps its default).

## Global Constraints

See the [master plan](2026-11-24-cli-build-workflow-master-plan.md#global-constraints). Plan A's `lib check` is in `LibraryCommands.cs`; keep it.

## Review Focus

1. **A second iecode waiting on the lock while the first is killed**: the mutex is abandoned; the waiter must continue, not fail (Task 1 test `AbandonedLockIsAcquired`).
2. **`lib update --lib A=1.0.0.0 --to 2.0.0.0`**: a version in the pair and `--to` at once is a usage error, not a silent choice (Task 2 test `PairAndToConflict`).
3. **`lib uninstall --all` matching nothing**: exit 3 with "no installed library of vendor X at version Y", never a RepTool call with an empty list (Task 3 test `SelectNothingIsEmpty` plus the command check).
4. **Wildcards with regex characters in names** (`Tc3_Motor.Lib` is not a pattern): only `*` and `?` are special (Task 3 test `DotIsLiteral`).
5. **A stray version is the only installed one** (`10.0.0.0` alone): no warning without a second version to compare with (Task 4 test `SingleVersionIsNotStray`).

---

### Task 1: `RepositoryLock` around every repository write

**Files:**
- Create: `cli/src/IECode.Core/RepositoryLock.cs`
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`SaveLibrary` when `install`, `SaveAll` per saved item when `--install`, `Restore`, `Install`, `InstallProject`, `Uninstall`)
- Modify: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs` (`ws build` around `SaveAsLibrary(..., install: true)`, `ws release`)
- Test: `cli/tests/IECode.Core.Tests/RepositoryLockTests.cs`

**Interfaces:**
- Produces: `public sealed class RepositoryLock : IDisposable { public const string Name = @"Local\iecode-library-repository"; public static RepositoryLock Acquire(Reporter log, TimeSpan timeout, string name = Name); }` throws `IECodeException(ExitCodes.Timeout, ...)` when not acquired in time. Logs `Waiting for another iecode library install…` once when the first `WaitOne(0)` fails.

- [ ] **Step 1: Write the failing tests** (use a unique `name` per test, e.g. `Local\iecode-test-` + Guid)

```csharp
[Fact] public void SecondAcquireWaitsUntilTheFirstIsReleased()
{
    var name = Unique();
    var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
    var t = Task.Run(() => { using var _ = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name); return DateTime.UtcNow; });
    Thread.Sleep(300);
    var released = DateTime.UtcNow; first.Dispose();
    Assert.True(t.Result >= released);
}

[Fact] public void TimesOut()
{
    var name = Unique();
    using var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
    var e = Task.Run(() => Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(200), name))).Result;
    Assert.Equal(ExitCodes.Timeout, e.ExitCode);
}

[Fact] public void AbandonedLockIsAcquired()
{
    var name = Unique();
    var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name)); // never disposed: abandoned when the thread ends
    th.Start(); th.Join();
    using var second = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name);
}
```

(A `Mutex` is owned by a thread; each acquire in the tests runs on its own thread on purpose. In the CLI all acquires are on the STA main thread.)

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*RepositoryLockTests"`
Expected: build error.

- [ ] **Step 3: Implement** with `new Mutex(false, name)`, `WaitOne(timeout)`, `AbandonedMutexException` = acquired (log `Detail`), `ReleaseMutex` and `Dispose` in `Dispose`. Wire with `using var _ = RepositoryLock.Acquire(ctx.Log, timeout)` where `timeout` is `--timeout` or 1800 s. Lock only the install or uninstall step, not the shell start or the build.

- [ ] **Step 4: Run to verify they pass**

Run: the commands of step 2, then `dotnet build cli/IECode.slnx`. Expected: pass, solution builds.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Serialise writes to the library repository" -m "Parallel library installs from several shells left one version listed but unusable; one named mutex per session makes the installs run one after another without slowing the builds around them."
```

### Task 2: `lib update` for several libraries and for a whole vendor

**Files:**
- Create: `cli/src/IECode.Core/Projects/LibrarySelection.cs`
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`Update()`: `--lib` becomes `Option<string[]>`, not required)
- Test: `cli/tests/IECode.Core.Tests/LibrarySelectionTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record UpdateItem(string Library, string? Version);` (`Version` null = take `--to` / latest)
  - `public static IReadOnlyList<UpdateItem> LibrarySelection.ParseUpdate(IReadOnlyList<string> libs, string? to, string? vendor, IEnumerable<PlcProjectFile> projects)`
  - Rules: `name=version` pairs and bare names; a pair plus `--to` is exit 2; no `--lib` but `--vendor` and `--to` = every library of that vendor referenced in `projects` (distinct, case-insensitive); no `--lib` and no `--vendor` is exit 2; `--from-project` keeps requiring exactly one `--lib`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void PairsAndBareNames() =>
    Assert.Equal([new UpdateItem("Tc3_MotorLib", "1.2.0.0"), new UpdateItem("Tc3_AxisLib", null)],
        LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.2.0.0", "Tc3_AxisLib"], null, null, []));

[Fact] public void PairAndToConflict() =>
    Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() =>
        LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.2.0.0"], "2.0.0.0", null, [])).ExitCode);

[Fact] public void VendorWithoutLibTakesAllReferencedLibrariesOfThatVendor() =>
    Assert.Equal(["Tc3_AxisLib", "Tc3_MotorLib"],
        LibrarySelection.ParseUpdate([], "2.0.0.0", "example", [project]).Select(i => i.Library).Order());

[Fact] public void NothingSelectedIsAUsageError() =>
    Assert.Throws<IECodeException>(() => LibrarySelection.ParseUpdate([], "2.0.0.0", null, []));
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*LibrarySelectionTests"`
Expected: build error.

- [ ] **Step 3: Implement** `ParseUpdate`; in `Update()` loop over the items, resolve `latest` per item as today, call `SetLibraryVersion` per item, keep the output lines and the JSON shape (`changes` list); `library` and `version` in JSON become arrays only when more than one item was given (keep single values for one item so existing callers see no change).

- [ ] **Step 4: Run to verify they pass**

Run: the commands of step 2. Expected: pass; existing `lib update` tests green.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Let lib update set several libraries in one call" -m "Re-pinning all libraries of one vendor needed a regex script; repeatable --lib name=version and --vendor with --to cover it while one-library calls keep their output."
```

### Task 3: `lib uninstall --all` and `lib installed` filters

**Files:**
- Modify: `cli/src/IECode.Core/Projects/LibrarySelection.cs`
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`Uninstall()`: names `ZeroOrMore`, `--all`; `Installed()`: wildcard `--lib`, `--vendor`)
- Test: `cli/tests/IECode.Core.Tests/LibrarySelectionTests.cs`

**Interfaces:**
- Produces:
  - `public static bool LibrarySelection.NameMatches(string pattern, string name)` (case-insensitive; `*` and `?` only)
  - `public static IReadOnlyList<InstalledLibrary> LibrarySelection.Select(IEnumerable<InstalledLibrary> installed, string? namePattern, string? vendor, string? version)` (`version` null or `all` = any)

- [ ] **Step 1: Write the failing tests**

```csharp
[Theory]
[InlineData("Tc3_*", "Tc3_MotorLib", true)]
[InlineData("tc3_motor?ib", "Tc3_MotorLib", true)]
[InlineData("Tc2_*", "Tc3_MotorLib", false)]
public void Wildcards(string p, string n, bool m) => Assert.Equal(m, LibrarySelection.NameMatches(p, n));

[Fact] public void DotIsLiteral() => Assert.False(LibrarySelection.NameMatches("Tc3_Motor.Lib", "Tc3_MotorXLib"));

[Fact] public void SelectByVendorAndVersion() =>
    Assert.Equal(["Tc3_AxisLib", "Tc3_MotorLib"], LibrarySelection.Select(Repo, null, "example", "1.3.1.0").Select(i => i.Name).Order());

[Fact] public void SelectNothingIsEmpty() => Assert.Empty(LibrarySelection.Select(Repo, null, "example", "9.9.9.9"));
```

- [ ] **Step 2: Run to verify they fail** (commands as in Task 2). Expected: build error.

- [ ] **Step 3: Implement** both; `uninstall`: `--all` requires `--vendor` and an explicit `--version` (not `all`, to avoid wiping every version by accident) and no names; it takes the names from `Select` over the repository scan, exits 3 when empty, and still asks for confirmation (shows the list). Names together with `--all` is exit 2.

- [ ] **Step 4: Run to verify they pass.** Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Add lib uninstall --all and lib installed filters" -m "Removing one version of twenty libraries meant building the name list by hand; the selection now comes from the repository scan, with wildcards and a vendor filter for lib installed as well."
```

### Task 4: Resolved `*` in `lib list` / `info`, stray versions, `lib save` to `dist/`

**Files:**
- Modify: `cli/src/IECode.Core/Projects/LibraryRepository.cs` (`Stray`)
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`List()`, `SaveLibrary` default out folder), `ProjectCommands.cs` (`Info()`)
- Test: `cli/tests/IECode.Core.Tests/ProjectTests.cs` (`LibraryRepositoryTests` class)

**Interfaces:**
- Produces: `public static InstalledLibrary? LibraryRepository.Stray(IEnumerable<InstalledLibrary> installed, string name, string? vendor)`: the newest version when its major is at least 5 above the major of the second newest; else null.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void FarHigherNewestIsStray() =>
    Assert.Equal("10.0.0.0", LibraryRepository.Stray([I("1.5.2.0"), I("10.0.0.0"), I("1.4.0.0")], "Tc3_MotorLib", null)?.Version);

[Fact] public void NormalStepIsNotStray() =>
    Assert.Null(LibraryRepository.Stray([I("1.5.2.0"), I("2.0.0.0")], "Tc3_MotorLib", null));

[Fact] public void SingleVersionIsNotStray() =>
    Assert.Null(LibraryRepository.Stray([I("10.0.0.0")], "Tc3_MotorLib", null));
```

- [ ] **Step 2: Run to verify they fail** (`--filter-class "*LibraryRepositoryTests"`). Expected: build error.

- [ ] **Step 3: Implement** `Stray`; `lib list`: when a repository is found (`ScanAll` over the candidates, from Plan A), print `newest (*) → 1.5.2.0` instead of `newest (*)`, and a warning `Tc3_MotorLib: * resolves to 10.0.0.0, far above 1.5.2.0; uninstall it if it is a test build.`; JSON reference gains optional `resolvedVersion`. `info` prints `· N references (M resolve with *)`. `lib save` without `-o`: `Path.Combine(<solution dir>, "dist")`, as `save-all`.

- [ ] **Step 4: Run to verify they pass.** Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Show what star references resolve to and save libraries to dist" -m "A stray 10.0.0.0 test build kept winning over the real release because nothing showed which version * picked; lib save now also writes to dist like save-all instead of leaving an untracked file next to the solution."
```

### Task 5: Docs and one manual check

- [ ] **Step 1:** `cli/README.md` rows for `lib update` (repeatable `--lib`, `--vendor` without `--lib`), `lib uninstall --all`, `lib installed --lib <pattern> --vendor`, `lib save` default output; `extension/CHANGELOG.md` (`lib save` default output is a behaviour change).
- [ ] **Step 2 (TwinCAT PC, 15 min):** start two `iecode lib save <sln> --install` of two different library solutions at the same time. Expected: the second prints `Waiting for another iecode library install…`; afterwards a build that references both versions finds them (no "not installed").
- [ ] **Step 3:** Commit docs (`git commit -s`, why-body).

## Known limits

- The lock is per Windows session (`Local\`); installs from two sessions (e.g. a service and a user) are not serialised.
- The lock does not prove the lost install of the run was caused by parallel installs (Q4); `lib verify` stays open until it is reproduced.
- The stray rule (major gap of 5) is a heuristic.
