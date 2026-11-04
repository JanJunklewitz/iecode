# ADS MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code reaches the five ADS tools of the window that serves its working directory, through one user-scope stdio MCP server (`iecode mcp`).

**Architecture:** A thin .NET relay (`iecode mcp`) picks the VS Code window by a discovery file, authenticates to it over a named pipe and forwards MCP lines. The extension serves one pipe per window and runs the MCP handling on top of the already built `adsTools` and write gate. Pure logic sits in `extension/src/core/` and `cli/src/IECode.Core/Mcp/` so it is unit-tested without VS Code or a real pipe.

**Tech Stack:** TypeScript 5.9, VS Code API 1.95, `node:net`, `node:crypto`, `node:test` (no runtime dependencies); .NET 10, `System.CommandLine`, xunit.v3.

**Spec:** [docs/superpowers/specs/2026-11-03-ads-mcp-server-design.md](../specs/2026-11-03-ads-mcp-server-design.md) (bridge revision, commit 869b17e)

**Replaces:** Tasks 1 and 6 to 9 of [2026-11-03-ads-mcp-server.md](2026-11-03-ads-mcp-server.md). Its Tasks 2, 2b, 3, 4 and 5 are built on this branch and are not repeated; its decision ledger (R1 to R29, D20, D21) still applies where the spec says so. Task 1 below is a hard gate for Tasks 4 to 8.

## Global Constraints

- No runtime dependencies in the extension (`tsc -p .`, `vsce package --no-dependencies`); none in the CLI beyond what it already references.
- Public repository: no internal names, links, machine names or data in code, tests, docs or commits. Commits: GitHub noreply author, `git commit -s`, English, subject plus a 1-3 sentence why-body.
- MCP server name `iecode`; tools `ads_symbols`, `ads_watch`, `ads_read`, `ads_scope`, `ads_write`; registration `claude mcp add -s user iecode -- <absolute path of iecode.exe> mcp`.
- The bridge writes only MCP messages to stdout, logs to stderr, exits when stdin closes. It knows no ADS and no write rules.
- Discovery directory `%LOCALAPPDATA%\iecode\mcp\v1\` (`instances\<id>.json`, `tools.json`, the marker file `connected`); pipe `\\.\pipe\iecode-mcp-<id>`; frames are newline-delimited UTF-8 JSON, at most 1 048 576 bytes per line; the secret is never sent.
- A write is "Not written" only with proof that nothing reached the PLC (R19); `iecode.ads.aiWrites` default stays `off` and is read from the user settings only.
- Only a local Windows extension host (`vscode.env.remoteName === undefined`, `process.platform === 'win32'`).
- Tests: `cd extension && npm test`; CLI tests with `dotnet test` through the PowerShell tool only, never chained with `dotnet build`, nothing heavy in parallel.

## Wire contract (both sides implement exactly this)

Instance file `instances\<id>.json`, written atomically (temp file, rename) after the pipe listens:

```json
{ "format": 1, "id": "<32 hex>", "pid": 123, "startedAt": "<ISO 8601>", "extensionVersion": "1.2.3",
  "bridgeProtocol": { "min": 1, "max": 1 }, "pipe": "iecode-mcp-<id>", "roots": ["c:\\work\\plant"],
  "workspaceName": "plant", "rootsRevision": 1, "secret": "<base64, 32 random bytes>" }
```

Handshake on every new pipe connection, one JSON object per line, before any MCP line (`proof(role) = base64(HMAC-SHA256(secret bytes, "<role>|<extNonce>|<bridgeNonce>"))`, nonces are base64 of 16 random bytes):

1. extension → bridge: `{"hello":"iecode-ext","nonce":"<extNonce>"}`
2. bridge → extension: `{"hello":"iecode-bridge","protocol":1,"nonce":"<bridgeNonce>","proof":"<proof(bridge)>"}`
3. extension → bridge: `{"ok":true,"proof":"<proof(ext)>"}`; on a wrong proof the extension closes the connection without a reply.

The bridge verifies step 3's proof; a mismatch or a close means "this instance is not usable". After step 3 every line is one MCP JSON-RPC message. One connection is one Claude session.

## Review Focus

1. Claude started outside every root, or its window closed → every call returns the "no window" error naming the folder, and works again once the window opens, without a Claude restart (Task 5 tests `no window gives a tool error naming the folder`, `a window that appears later is found`).
2. Same folder served by two live windows → conflict error naming both workspaces, nothing sent (Task 4 test `two live instances with the same best root are a conflict`).
3. Pipe breaks while a call is open → "may or may not have run", the call is never re-sent (Task 5 test `lost connection during a call is reported and not replayed`).
4. Anything but MCP lines on stdout (a log line, a banner) breaks Claude's session (Task 5 test `stdout carries only MCP lines`).
5. Stale discovery file after a crash (dead pipe, reused pid), a path with a lower-case drive letter, trailing separator or a similarly named folder (`plant` against `plant-old`) → not counted, not matched (Task 4 tests `a dead instance is neither match nor conflict`, `plant does not match plant-old`, `canonical path ignores drive case and trailing separator`).
6. The window with the longest or the only matching root is paused in a debugger (pipe up, handshake silent) → the call fails with "did not answer" and is never sent to a shorter root or another window (Task 4 tests `a paused window with the longest root blocks the fallback`, `a paused window with the same root blocks instead of choosing the other`; Task 5 test `an unsure window gives a tool error and nothing is sent`).
7. Claude cancels a call while the bridge still selects a window or runs the handshake → the call is never sent and no dialog opens (Task 5 test `cancel during selection drops the call`).
8. A `tools/call` without an id, or with an id that is still running → refused before any tool runs (Task 2 tests `tools/call without an id is refused`, `a duplicate running id is refused`).

---

### Task 1: Go/no-go spike (throwaway)

Not merged. Gate for Tasks 4 to 8. Findings go into the "Spike results" section at the end of this file (commit only that).

**Files:**
- Create (scratchpad, not in the repo): `spike-stdio.js`, a ~60-line stdio MCP server: answers `initialize`, `tools/list` (tool `ping_tool` with `seconds`), `tools/call` (sleeps, returns "pong"), logs cwd, `process.env` keys, every received line and every signal/stdin close to a file.

- [ ] **Step 1: Register at user scope** `claude mcp add -s user spike -- node <path>\spike-stdio.js`; `claude mcp list` shows `spike` connected.
- [ ] **Step 2: Working directory.** In the terminal, start Claude in a project root, in a subfolder, in a folder opened with a lower-case drive letter and in a junction; in the user's Claude Code VS Code extension, open a single-folder and a multi-root workspace. Record the logged cwd for each. **Pass:** the project root, or a subfolder inside it. **Fail:** anything not inside the folder the session was opened for (for example the home directory).
- [ ] **Step 3: Protocol.** Record the `protocolVersion` of `initialize`, the methods Claude sends, the tool timeout of `ping_tool seconds=300`, what Esc sends during a call (`notifications/cancelled`?), and what the child sees when the session ends (stdin EOF or kill).
- [ ] **Step 4: Empty and cached tool list.** Make `tools/list` return an empty list, then the real one while the session runs; record whether Claude shows tools it listed at start and whether it picks up changes. Restart the server (kill the child) and record whether Claude restarts it.
- [ ] **Step 5: ACLs.** From Node create `\\.\pipe\spike-acl` and run `Get-Acl` (or `accesschk`) on it; run `icacls %LOCALAPPDATA%\iecode` after creating the folder. Record whether another local user could read the folder or connect to the pipe.
- [ ] **Step 6: `claude mcp get spike`** output (server up and down); save it as the fixture for Task 7's `registeredExe` test. Also record where the Claude Code VS Code extension's own `claude` binary lives and whether a `claude` is on `PATH` for the user (Task 7's lookup).
- [ ] **Step 6b: Clean up:** `claude mcp remove -s user spike`, delete the scratchpad files and the test pipe.
- [ ] **Step 7: Decide and commit.** Record the tool timeout from Step 3 in the results; Task 6 derives the write gate deadlines from it. Pass: continue with Task 4. Fail: stop and bring the findings and the two fallbacks of the spec (per-project registration with a folder argument, or the HTTP design) to the user. Commit `Docs: spike results for the ADS MCP stdio bridge` (why: the working directory and ACL facts decide the design).

---

### Task 2: MCP session in the extension (pure)

May start before the spike ends: any transport would reuse it.

**Files:**
- Create: `extension/src/core/mcp.ts`
- Test: `extension/test/mcp.test.ts`

**Interfaces:**
- Consumes: nothing from the VS Code API; tool results use the `{ text, isError? }` shape of `adsTools` and `writeResultIsError`.
- Produces:
  ```ts
  export interface McpTool { name: string; description: string; inputSchema: object;
    call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> }
  export class McpSession {
    constructor(tools: McpTool[], maxReplyBytes?: number);   // default 1_048_576
    handle(line: string): Promise<string | undefined>;   // one MCP line in; the reply line, undefined for notifications
    close(): void;                                       // connection closed: aborts every running call
  }
  ```
  Methods: `tools/list` → `{ tools: [{ name, description, inputSchema }] }`; `tools/call` → `{ content: [{ type: 'text', text }], isError }` (unknown tool → `-32602`); `ping` → `{}`; a `tools/call` without an `id` (notification form) or with an `id` that is still running → `-32600`, no tool runs (so two running calls never share an id and a cancel can never be ambiguous); numeric `5` and string `"5"` are different ids; `notifications/cancelled` → abort the running call with that `requestId` (a missing or non-string/number `requestId` is ignored); a reply whose UTF-8 length exceeds `maxReplyBytes` is replaced by a tool result `isError: true` with the text `The result is too large to send. Ask for less.`; other notifications → no reply; unknown method with an `id` → `-32601`; invalid JSON → `-32700`; a JSON array (batch) or a message without `method` → `-32600`. A tool that throws gives a tool result with `isError: true`, never a crash. `initialize` is answered by the bridge, not here.

- [ ] **Step 1: Write failing tests:** `tools/list lists the tools`, `tools/call returns text content`, `tools/call marks errors`, `unknown tool gives -32602`, `unknown method gives -32601`, `notification gets no reply`, `invalid JSON gives parse error`, `batch gives invalid request`, `cancelled notification aborts the running call`, `tools/call without an id is refused` (the tool never runs), `a duplicate running id is refused` (the second call never runs, the first is not cancelled by it), `ids 5 and "5" are different`, `cancel with a malformed requestId is ignored`, `an oversized reply becomes a tool error` (multibyte text whose escaped form is over the limit), `close aborts every running call`, `a throwing tool gives an error result`, `a cancel is handled while another call is still running` (`handle` calls never wait for each other).
- [ ] **Step 2: Run** `cd extension && npm test`. Expected: the new tests FAIL (module missing).
- [ ] **Step 3: Implement** `McpSession`; JSON-RPC ids may be numbers or strings, keep them as given.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: MCP session for the ADS tools` (why: hand-written to keep the extension free of runtime dependencies; transport-independent so a fallback can reuse it).

---

### Task 3: Wire contract, extension side (pure)

**Files:**
- Create: `extension/src/core/mcpWire.ts`, `extension/src/core/mcpPipe.ts`, `extension/src/core/instanceFiles.ts`
- Create: `testdata/mcp-wire.json` (repo root; the one golden fixture both languages read: `{ "secret", "extNonce", "bridgeNonce", "bridgeProof", "extProof" }`, values computed once with an independent tool such as PowerShell `HMACSHA256`, so the two implementations cannot drift apart unnoticed)
- Test: `extension/test/mcpWire.test.ts`, `extension/test/mcpPipe.test.ts`, `extension/test/instanceFiles.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_FRAME = 1_048_576;
  export interface InstanceFile { format: 1; id: string; pid: number; startedAt: string; extensionVersion: string;
    bridgeProtocol: { min: number; max: number }; pipe: string; roots: string[]; workspaceName: string;
    rootsRevision: number; secret: string }
  export function proof(secret: string, role: 'bridge' | 'ext', extNonce: string, bridgeNonce: string): string;
  export function proofMatches(expected: string, given: string | undefined): boolean;   // constant time
  export class FrameTooLong extends Error {}
  export class LineFramer { constructor(max?: number); push(chunk: Buffer | string): string[]; }  // complete lines, partial kept; throws FrameTooLong
  export class ExtHandshake {
    constructor(secret: string, nonce?: string);
    first(): string;                                      // line 1
    onLine(line: string): { reply?: string; done?: true; fail?: true };   // consumes line 2, replies with line 3
  }
  export function canonicalRoot(p: string, realpath: (p: string) => string): string; // realpath, backslashes, lower-case drive letter, no trailing separator
  export function toolsFile(tools: { name: string; description: string; inputSchema: object }[]): string;

  // core/mcpPipe.ts: the extension's listener, free of the VS Code API so it runs under node --test
  export interface PipeConnection { send(line: string): void; onLine(fn: (line: string) => void): void; onClose(fn: () => void): void; close(): void }
  export function servePipe(pipePath: string, secret: string, onSession: (c: PipeConnection) => void): Promise<{ close(): Promise<void> }>;
  // runs ExtHandshake first; `onSession` fires only for an authenticated client; a wrong proof, a malformed line or a line over MAX_FRAME closes the socket without a reply

  // core/instanceFiles.ts: filesystem calls injected so the logic is tested without touching %LOCALAPPDATA%
  export interface FsOps { mkdir(p: string): void; write(p: string, text: string): void; rename(a: string, b: string): void;
    list(dir: string): string[]; read(p: string): string; remove(p: string): void; exists(p: string): boolean; mtimeMs(p: string): number }
  export function writeInstance(dir: string, file: InstanceFile, fs: FsOps): void;   // temp file, then rename; calling it again refreshes the mtime (the owner's heartbeat)
  export function removeInstance(dir: string, id: string, fs: FsOps): void;
  export function sweepStaleInstances(dir: string, fs: FsOps, now: number, maxAgeMs: number, canConnect: (pipe: string) => Promise<boolean>): Promise<void>;
  // deletes a file only when it was not refreshed for `maxAgeMs` (10 minutes in use) AND its pipe cannot be connected; a fresh file is never touched, so a paused or busy window is never erased by another window. Pid and start time are informational only (Node cannot read another process's start time).
  export const CONNECTED_MARKER = 'connected';            // file in the discovery directory: the user-level "serve every window" switch
  export function setConnectedMarker(dir: string, on: boolean, fs: FsOps): void;
  export function connectedMarker(dir: string, fs: FsOps): boolean;
  export function aclAllowsOthers(icaclsOutput: string): boolean;   // parses `icacls <dir>`: true when Everyone (S-1-1-0), BUILTIN\Users, or Authenticated Users has any grant; the owner, SYSTEM and Administrators are fine
  ```
  `PipeConnection.send(line)` throws `FrameTooLong` when the UTF-8 length of `line` exceeds `MAX_FRAME` (the caller turns that into an error reply), and writes of one connection never interleave.

- [ ] **Step 1: Write failing tests:** `proof differs per role`, `proofMatches rejects different lengths`, `proof matches the golden fixture` (reads `testdata/mcp-wire.json`), `framer splits lines across chunks`, `framer throws on a line over the limit`, `handshake accepts the right bridge proof and replies with the ext proof`, `handshake fails on a wrong proof`, `handshake fails on a malformed line`, `canonicalRoot ignores drive case and trailing separator` (inject `realpath`), `canonicalRoot resolves through realpath`; on a real temporary pipe (`\\.\pipe\iecode-test-<random>`): `servePipe authenticates a client that knows the secret`, `servePipe closes a client with a wrong proof without a reply`, `servePipe closes on an oversized line`, `servePipe calls onClose when the client disconnects`, `servePipe rejects a second server on the same pipe name`; with a fake `FsOps`: `writeInstance writes a temp file and renames it`, `removeInstance deletes only that instance`, `sweepStaleInstances keeps a fresh file even when its pipe is unreachable`, `sweepStaleInstances keeps an old file whose pipe answers`, `sweepStaleInstances deletes an old file with a dead pipe`, `sweepStaleInstances skips an unreadable file`, `writeInstance again refreshes the mtime`, `connected marker is set and cleared`, `aclAllowsOthers flags Everyone and Users and Authenticated Users`, `aclAllowsOthers accepts owner, SYSTEM and Administrators only` (fixtures: real `icacls` output of a default %LOCALAPPDATA% folder and of one with `Users:(R)` added), `send refuses a line over the limit in bytes` (multibyte), `two sends never interleave`; on the real pipe also `servePipe closes a client that stays silent after connecting` (5 s handshake timeout, so probes do not pile up).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:crypto` (`createHmac`, `timingSafeEqual`, `randomBytes`) and `node:net`.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: wire contract of the MCP bridge` (why: framing and the secret-based handshake are pure so both sides can be tested without a pipe).

---

### Task 4: Bridge core in the CLI (pure)

**Gate: Task 1 passed.**

**Files:**
- Create: `cli/src/IECode.Core/Mcp/Wire.cs`, `cli/src/IECode.Core/Mcp/Instances.cs`, `cli/src/IECode.Core/Mcp/Selection.cs`
- Test: `cli/tests/IECode.Core.Tests/McpWireTests.cs`, `cli/tests/IECode.Core.Tests/McpSelectionTests.cs`

**Interfaces:**
- Produces (namespace `IECode.Core.Mcp`):
  ```csharp
  public static class Wire {
    public const int Protocol = 1; public const int MaxFrame = 1_048_576;
    public static string Proof(string secret, string role, string extNonce, string bridgeNonce);
    public static bool ProofMatches(string expected, string? given);
    public static string RandomNonce();
  }
  public sealed class LineFramer { public LineFramer(int max = Wire.MaxFrame); public IReadOnlyList<string> Push(ReadOnlySpan<byte> chunk); }  // throws FrameTooLongException
  public static class BridgeHandshake { public static bool Run(Stream link, InstanceInfo info, TimeSpan timeout); }  // steps 1-3 of the wire contract from the bridge side; false on a wrong proof, a malformed line, a close or silence longer than `timeout`
  public sealed record InstanceInfo(string Id, int Pid, string ExtensionVersion, int ProtocolMin, int ProtocolMax,
    string Pipe, IReadOnlyList<string> Roots, string WorkspaceName, string Secret);
  public static class Instances { public static IReadOnlyList<InstanceInfo> Load(string instancesDir); }  // unreadable or format != 1 files are skipped
  public static class PathMatch { public static string Canonical(string path); public static bool Contains(string root, string path); }
  public abstract record Selection {
    public sealed record Chosen(InstanceInfo Instance, Stream Link) : Selection;
    public sealed record None : Selection;
    public sealed record Conflict(IReadOnlyList<InstanceInfo> Instances) : Selection;
    public sealed record VersionMismatch(InstanceInfo Instance) : Selection;
    /// <summary>A matching window did not answer in time (paused, busy): it may still own the folder, so nothing is sent anywhere.</summary>
    public sealed record Unsure(IReadOnlyList<InstanceInfo> Instances) : Selection;
    public static Selection Choose(string cwd, IReadOnlyList<InstanceInfo> all, Func<InstanceInfo, Probe> connect);
  }
  public abstract record Probe {
    public sealed record Ok(Stream Link) : Probe;     // connected and authenticated
    public sealed record Absent : Probe;              // the pipe does not exist or refuses: the window is gone
    public sealed record Silent : Probe;              // connect or handshake timed out, closed early or sent a malformed line: unknown state
  }
  ```
  `connect` does the pipe connect and the handshake. `Absent` only for a pipe that does not exist or a refused connect (proof that the window is gone); every timeout, early close or wrong proof is `Silent`. `Choose`: candidates are instances with a root that `Contains` the canonical `cwd`; group by the length of their best root; walk the groups from the longest; the candidates of a group are probed in parallel (a few paused windows must not add their timeouts up). A group decides when it has at least one `Ok` or one `Silent`: only `Ok` → one `Chosen`, several `Conflict` (every opened stream disposed); any `Silent` → `Unsure` (also when another instance of the group is `Ok`, because the silent one may be a second window on the same folder; opened streams disposed). A group with only `Absent` instances is skipped and the next, shorter group is walked. An instance whose protocol range excludes `Wire.Protocol` yields `VersionMismatch` when nothing else is usable; no candidate at all → `None`.

- [ ] **Step 1: Write failing tests** (`McpWireTests`): `proof matches the golden fixture` (reads `testdata/mcp-wire.json` from the repo root, the same file as the extension tests), `proofMatches rejects different lengths`, `framer splits lines across chunks`, `framer throws on a line over the limit`, `framer decodes UTF-8 split across chunks`, and with an in-memory stream pair playing the extension: `handshake accepts a peer that knows the secret`, `handshake rejects a wrong extension proof`, `handshake times out on a silent peer` (a debugger-paused extension host must not hang the bridge), `handshake rejects a peer that closes early`.
- [ ] **Step 2: Write failing tests** (`McpSelectionTests`, `connect` is a fake): `canonical path ignores drive case and trailing separator`, `plant does not match plant-old`, `a subfolder of a root matches`, `longest root wins`, `a multi-root instance matches through any root`, `two live instances with the same best root are a conflict` (streams disposed), `an absent instance is neither match nor conflict`, `an absent instance with the longest root falls back to the next group`, `a paused window with the longest root blocks the fallback` (Silent → Unsure, the shorter root is not probed for a decision), `a paused window with the same root blocks instead of choosing the other` (one Ok, one Silent → Unsure, streams disposed), `a wrong proof counts as Silent, not Absent`, `no candidate gives None`, `protocol range without 1 gives VersionMismatch`, `unreadable instance file is skipped`, `a format 2 file is skipped`.
- [ ] **Step 3: Run** `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~Mcp"` (PowerShell tool). Expected: FAIL (types missing).
- [ ] **Step 4: Implement.** `Canonical`: `Path.GetFullPath`, resolve the final link target of every existing component with `FileSystemInfo.ResolveLinkTarget(true)`, backslashes, trailing separator removed, compare ordinal-ignore-case (Windows only). `Contains`: same folder or an ancestor, component by component.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `CLI: MCP bridge core, window selection and wire contract` (why: selection is where a wrong guess writes to the wrong PLC window, so it is pure and tested before any process exists).

---

### Task 5: `iecode mcp` command

**Gate: Task 1 passed.**

**Files:**
- Create: `cli/src/IECode.Core/Mcp/McpBridge.cs`, `cli/src/IECode.Cli/Commands/McpCommand.cs`, `cli/tests/IECode.Core.Tests/McpBridgeTests.cs`
- Modify: `cli/src/IECode.Cli/Program.cs` (register `McpCommand.Create()` next to the other `root.Subcommands.Add(...)` lines, after `DoctorCommand`), `cli/README.md` (the command, the discovery directory, the protocol range)

**Interfaces:**
- Consumes: Task 4 (`Instances.Load`, `Selection.Choose`, `Wire`, `LineFramer`).
- Produces:
  ```csharp
  public sealed class McpBridge {
    public McpBridge(string cwd, string instancesDir, string toolsFile, Func<InstanceInfo, Probe> connect,
                     Stream stdin, Stream stdout, Action<string> log);
    public Task RunAsync(CancellationToken ct);   // returns when stdin closes
  }
  internal static class McpCommand { public static Command Create(); }  // `iecode mcp`, Action(..., protocolStdout: true)
  ```
  Behaviour: `initialize` → result with the client's `protocolVersion` echoed if it is one of the versions the spike found, else the newest of them, `capabilities: { tools: { listChanged: true } }`, `serverInfo: { name: "iecode", version }`; `notifications/initialized` and `ping` answered or ignored locally. `tools/list`, `tools/call`, `notifications/cancelled`: `Selection.Choose` with `Instances.Load` and the real pipe `connect` (`NamedPipeClientStream(".", pipe, InOut, Asynchronous)`; a missing pipe or refused connect → `Probe.Absent`; a 500 ms connect timeout, then `BridgeHandshake.Run` with a 2 s timeout, a wrong proof or an early close → `Probe.Silent`, so a paused window is never mistaken for a gone one). Replies are matched by JSON-RPC id. Stdin is read concurrently with open calls. Every `tools/call` is selected on its own, whether or not other calls are open (a call that is still running keeps its own link; a new call may use a different window; the open link counts as the live probe of its instance, other candidates are probed with a 5 s cache that never caches `Silent`): a second window with the same folder turns the next call into a conflict, a longer root that appears later wins, and a call never goes to a window other than the one `Choose` returns for it. Nothing is promised across windows beyond that moment (a window can still close right after).
  Request state: the bridge creates the state of a `tools/call` (its id, a cancel latch) before the first `await` of the selection. A `notifications/cancelled` for an id whose call has no link yet sets the latch, and the call is dropped without being sent (the client gets no reply for a cancelled call, as in MCP); when the link exists the cancel line is forwarded after the call line on that same link, in order. A `tools/call` without an `id`, or with an id that is still open, gets a JSON-RPC error `-32600` from the bridge and is never forwarded. A cancel for an unknown id is dropped. Every outgoing line to stdout goes through one serialized writer, and a reply over `Wire.MaxFrame` bytes (UTF-8) is replaced by the tool error `The result is too large to send. Ask for less.`. At most 32 calls may be open at once; more get the tool error `Too many calls are running at once.`, and cancels are never counted or refused. While no window is found and a `tools/list` was answered without one, a 5 s timer repeats the search and sends `notifications/tools/list_changed` once a window is found (the spike's Step 4 decides whether Claude re-lists; if it does not, the fallback is a static tool list inside the CLI instead of `tools.json`, decided with the user then). Without a window, `tools/list` returns `tools.json` (or an empty list when the file is missing) and `tools/call` returns a tool error `No VS Code window with IECode is open for <cwd>. Ask the user to open the folder in VS Code.`; `Conflict` → tool error `workspace <name> and workspace <name> both serve <folder>`; `Unsure` → tool error `The IECode window for <folder> did not answer in time (a paused debugger can cause this). Nothing was sent. Ask the user to resume it, then retry.`; `VersionMismatch` → tool error naming which side (CLI or extension) to update. A link that breaks with calls open gives each of them the tool error `The connection to IECode was lost during the call, so it may or may not have run. Read the state before acting; for a write, read the variable and ask the user.` and is never re-sent. Stdout carries only MCP lines; everything else goes to `log` (stderr).
  `McpCommand` resolves `cwd = Directory.GetCurrentDirectory()`, `instancesDir = %LOCALAPPDATA%\iecode\mcp\v1\instances`, `toolsFile = ...\tools.json`.

- [ ] **Step 1: Write failing tests** with in-memory streams and a fake `connect`: `initialize is answered without a window`, `ping is answered without a window`, `tools/list forwards to the window`, `tools/list falls back to tools.json without a window`, `tools/list is empty without a window and without tools.json`, `no window gives a tool error naming the folder`, `a window that appears later is found`, `conflict gives a tool error naming both workspaces`, `version mismatch names the side to update`, `cancel is forwarded while a call is open`, `lost connection during a call is reported and not replayed`, `reply goes to the call with the same id`, `a window found after a list without window sends list_changed`, `a second window with the same folder turns the next call into a conflict`, `a longer root that appears later wins at the next call`, `a second window turns the next call into a conflict while another call is still open`, `an unsure window gives a tool error and nothing is sent`, `cancel during selection drops the call` (fake `connect` that blocks, cancel arrives, `connect` then returns: no line reaches the link), `cancel is forwarded after its call on the same link`, `a cancel for an unknown id is dropped`, `tools/call without an id gets -32600 and is not forwarded`, `a duplicate open id gets -32600 and is not forwarded`, `an oversized reply becomes a tool error`, `more than 32 open calls get a tool error but a cancel still passes`, `concurrent replies never interleave on stdout`, `stdout carries only MCP lines` (a log call and a failing connect leave stdout parseable line by line), `exits when stdin closes`.
- [ ] **Step 2: Run** `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~McpBridge"`. Expected: FAIL.
- [ ] **Step 3: Implement** `McpBridge` and `McpCommand`; `Console.Out` is replaced by the protocol stream only in the command, the class takes streams.
- [ ] **Step 4: Run** the filter, then the whole CLI suite (`dotnet test cli/tests/IECode.Core.Tests`, then `cli/tests/IECode.Automation.Tests`, one after the other). Expected: all PASS.
- [ ] **Step 5: Commit** `CLI: iecode mcp relays MCP lines to the window that serves the folder` (why: a user-scope stdio entry replaces per-folder HTTP registration; the relay stays free of ADS and write rules).

---

### Task 6: The extension serves a window

**Gate: Task 1 passed.**

**Files:**
- Create: `extension/src/core/mcpTools.ts`, `extension/test/mcpTools.test.ts` (pure: building the five MCP tools and the `ads_write` mapping)
- Create: `extension/src/ads/mcpServer.ts`
- Modify: `extension/src/extension.ts:128-131` (create the server next to the gate, dispose it), `extension/src/views/adsWatch.ts` (description gains `MCP: on`), `extension/package.json` (rewrite the five `modelDescription`s and the `aiWrites` description and picker text so they hold for both clients: no `#adsWatch`/`adsScope` names, per-client approval detail out of the tool text; `lmTools.ts` keeps its Copilot-only hint in `prepareInvocation`)
- Test: `extension/test/mcpTools.test.ts`; the VS Code module itself is checked by hand.

**Interfaces:**
- Consumes: `adsTools(ctx, state, MCP_NAMES)`, `adsWriteGate` / `WriteGate.run`, `parse*Input`, `writeResultText`, `writeResultIsError` (built); `McpSession` (Task 2); `servePipe`, `canonicalRoot`, `toolsFile`, `InstanceFile`, `writeInstance`, `removeInstance`, `sweepStaleInstances`, `connectedMarker`, `setConnectedMarker` (Task 3). The tool building and the `ads_write` mapping live in a pure module (see below), so the riskiest seam is unit-tested.
- Produces:
  ```ts
  // core/mcpTools.ts (pure)
  export interface ToolDescriptor { name: string; description: string; inputSchema: object }   // from package.json, `iecode_ads_<x>` already renamed to `ads_<x>`
  export function buildMcpTools(d: { descriptors: ToolDescriptor[]; tools: ReturnType<typeof adsTools>;
    gate: WriteGate; targetKey(): string }): McpTool[];
  // ads_write → parseWriteInput → gate.run({ symbol, value, targetKey: d.targetKey(), via: 'MCP' }, signal) → writeResultText, isError from writeResultIsError

  // ads/mcpServer.ts
  export class AdsMcpServer implements vscode.Disposable {
    constructor(ctx: vscode.ExtensionContext, state: WorkspaceState, gate: WriteGate);
    start(): Promise<void>;        // pipe, then the instance file; no-op unless `connected()`
    stop(): Promise<void>;         // closes connections, deletes the instance file
    serving(): boolean;
    connected(): boolean;          // the marker file `connected` in the discovery directory (shared by all windows; `globalState` is a per-host snapshot and not fit for this)
    setConnected(on: boolean): Promise<void>;   // writes or deletes the marker; this window starts or stops at once
    readonly onState: vscode.Event<void>;
  }
  ```
  Lifecycle: `start()`, `stop()`, the marker poll, the heartbeat and the workspace-folder handler run through one serialized queue and a generation counter that `stop()` and `dispose()` increment; every step of `start()` re-checks the generation after each `await` (sweep, listen, publish) and, when it changed, closes what it opened and writes nothing, so a late start never publishes after a stop. Timers are cleared in `stop()`, and a heartbeat or folder event of an old generation does nothing.
  Private directory: before publishing any secret, `start()` creates the discovery directory and runs `icacls <dir>` through `aclAllowsOthers`; when others have access it removes the inherited grants for them (`icacls <dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`) and checks again; if it is still open the server does not serve and shows the warning `IECode: the discovery folder <dir> is readable by other users, so the MCP server stays off.` Instance files and their temp files are written inside that directory only.
  Every window polls the marker every 5 s (`fs.existsSync`, builder's call on `fs.watch`): present → start serving, absent → stop and delete its instance file. So a window that was open before Connect starts serving without a reload, and Disconnect stops every window.
  Per authenticated connection (`servePipe`): each line goes to one `McpSession` built from `buildMcpTools` (descriptions and `inputSchema` read from `ctx.extension.packageJSON.contributes.languageModelTools`); lines are handled concurrently, never queued behind a running call, so a `notifications/cancelled` is processed while a write waits for its dialog. A closing connection calls `session.close()` (every unsent write of the session is refused). At start: `sweepStaleInstances` (10 minutes, pipe connect probe), write `tools.json` from `toolsFile`, `servePipe` on `\\.\pipe\iecode-mcp-<id>`, then `writeInstance`; the owner calls `writeInstance` again every 60 s (heartbeat) and on `onDidChangeWorkspaceFolders` (with `rootsRevision + 1`); `removeInstance` in `stop()`. The write gate policy in `extension.ts:128` (`dialogMs 120 000`, `operationMs 150 000`) must fit Claude Code's tool timeout recorded by Task 1: set `operationMs = min(150 000, timeout − 10 000)` and `dialogMs = min(120 000, operationMs − 5 000)`, otherwise Claude gives up on a call while its dialog is still open (a non-positive result means the timeout is too short for writes: AI writes are then refused with a clear text, reads still work). Known limit, stated in the docs (Task 8): a modal dialog cannot be closed, so after a dialog timeout the next queued write waits until the user dismisses it; once a write request has been sent the gate does not time it out, the transport does (the host's own reply timeout), and the caller then gets `Outcome unknown`, never `Not written`. A listen or write error: one warning `IECode: the MCP server for Claude Code could not start: <reason>`, nothing else breaks.

- [ ] **Step 1: Write failing tests** (`mcpTools.test.ts`, real `WriteGate` and `McpSession` with a fake host and fake dialog): `tools/list names the five ads_ tools with their schemas`, `ads_write reaches gate.run with via MCP and the bound target`, `ads_write that is refused sets isError`, `closing the session refuses a write that is still waiting for its dialog`, `a cancel line aborts a queued write while another call is running` (the concurrency rule), `a call that throws gives an error result`, `a write whose send never answers ends as outcome unknown, not as not written` (fake host, fake clock; `send` was passed `beforeSend` first).
  In the policy helper (pure, `core/mcpTools.ts`, `gatePolicyFor(timeoutMs: number | undefined): GatePolicy | undefined`): tests `policy keeps 150/120 s for a long timeout`, `policy shrinks to the tool timeout`, `policy is undefined when the timeout leaves no room for a dialog` (then writes are refused).
  Lifecycle (pure `LifecycleQueue` in `core/mcpTools.ts` or its own module, builder's call): tests `a start that is still listening when stop runs publishes nothing`, `a heartbeat of an old generation writes nothing`, `stop clears the timers`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `core/mcpTools.ts`, then `mcpServer.ts` and the wiring (policy from Task 1's timeout); rewrite the `package.json` texts.
- [ ] **Step 4: Run** `npm test`. Expected: green (compiles, nothing regresses).
- [ ] **Step 5: Manual check, F5 session, no Claude needed:** create the marker file by hand (`%LOCALAPPDATA%\iecode\mcp\v1\connected`) while the Extension Development Host is already running, see the instance file appear within 5 s; delete the marker, see it disappear. Drive the contract with a small Node client script in the scratchpad: handshake with the secret from the file, `tools/list`, `tools/call` `ads_read` of a watched variable; wrong secret → connection closed without reply; kill the Extension Development Host → file stays (fresh), pipe dead, a bridge skips it.
- [ ] **Step 6: Commit** `Extension: serve the ADS tools of a window over a named pipe` (why: the bridge needs a per-window endpoint that other users and browsers cannot use without the secret).

---

### Task 7: Connect and Disconnect Claude Code

**Gate: Task 1 passed.**

**Files:**
- Create: `extension/src/core/claudeRegistration.ts`, `extension/src/ads/claudeConnect.ts`
- Modify: `extension/package.json` (commands `iecode.mcpConnect` "IECode: Connect Claude Code" and `iecode.mcpDisconnect` "IECode: Disconnect Claude Code", also in the ADS Watch view `…` menu), `extension/src/extension.ts`
- Test: `extension/test/claudeRegistration.test.ts`

**Interfaces:**
- Produces (core):
  ```ts
  export function addArgs(exe: string): string[];        // ['mcp','add','-s','user','iecode','--',exe,'mcp']
  export function removeArgs(): string[];                // ['mcp','remove','-s','user','iecode']
  export function getArgs(): string[];                   // ['mcp','get','iecode']
  export function manualCommand(exe: string): string;    // the add command as one quoted line for the clipboard
  export function registeredExe(getOutput: string): string | undefined;   // parsed from `claude mcp get iecode` (fixture from the spike)
  export interface RegisteredEntry { scope: string; transport: string; command: string; args: string[]; env: Record<string, string>; raw: string }
  export function parseEntry(getOutput: string): RegisteredEntry | undefined;   // the whole entry, not only the exe
  export function restoreArgs(e: RegisteredEntry): string[] | undefined;        // the `claude mcp add` arguments that recreate it; undefined when not expressible
  export function cmdLine(args: string[]): string;       // cmd.exe line for claude.cmd; throws on cmd metacharacters (R1)
  export function findOnPath(pathEnv: string, exists: (p: string) => boolean): { exe?: string; cmd?: string }; // absolute PATH entries only (R12)
  ```
- Produces (ads): `registerClaudeConnect(ctx, server: AdsMcpServer)` with the two commands.
  Connect: refuse with a message when `vscode.env.remoteName` is set or the platform is not Windows. Resolve the CLI with a new exported `resolveIecodeExe(): string | undefined` in `extension/src/cli/iecode.ts` (the existing `cliPath()` is private and returns a bare `iecode` when no setting is set, which is not an absolute path): `iecode.cliPath` if set, else `%LOCALAPPDATA%\iecode\iecode.exe` (the install dir, `INSTALL_DIR`) if it exists, else `findOnPath` for `iecode.exe`; absolute paths only. Run `<exe> mcp --help`: failure → message pointing at "IECode: Install CLI". Resolve `claude` with `findOnPath` and spawn its absolute path with an argument array (`claude.exe` first; `claude.cmd` through `cmd.exe /d /s /c` and `cmdLine`, `windowsVerbatimArguments`, R1, R12). The CLI path is trusted because `iecode.cliPath` has `"scope": "machine"` in `package.json` (a workspace cannot set it); keep that scope, the test `iecode.cliPath stays machine scoped` reads `package.json`. Registration changes of two windows are serialized by a lock file `registration.lock` in the discovery directory (created exclusively, stale after 60 s). If `getArgs` shows an `iecode` entry, its complete text is saved (`parseEntry(getOutput)`: scope, transport, command, args, env) before `removeArgs` then `addArgs`; when the add fails the saved entry is restored with the matching `add` arguments (`restoreArgs(entry)`), and when that is not possible the message says so with the saved text so the user can re-add it by hand. `getArgs` failing with "No MCP server found" means absent, any other failure aborts without a change. On failure report exit code and output, leave `connected` false. After success `server.setConnected(true)` and tell the user: `Claude Code connected. A running Claude session needs /mcp to reconnect or a restart. AI writes are currently "<value>"; change with "IECode: Set AI Write Access…".` `claude` not found on `PATH`: also try `%USERPROFILE%\.local\bin\claude.exe` and `%APPDATA%\npm\claude.cmd` (the native and npm installs; Task 1 Step 6 records where the VS Code extension's Claude lives); if still not found, offer `Copy Command` (`manualCommand`) and set `connected` only after the user confirms they ran it, and label that state "not verified" in the message.
  Disconnect: `removeArgs` when `registeredExe` is the iecode.exe this extension resolves and its args are exactly `['mcp']` (an entry that only shares the exe is left alone and the message says so); `server.setConnected(false)` (deletes the marker; every window notices within 5 s, Task 6).

- [ ] **Step 1: Write failing tests:** `addArgs builds the user-scope stdio registration`, `registeredExe reads the command of the entry` (fixture from the spike), `manualCommand quotes the path`, `cmdLine quotes arguments and refuses metacharacters` (R1), `findOnPath ignores the current folder and relative entries` (R12), `parseEntry keeps command, args and env of an existing entry` (spike fixture), `restoreArgs rebuilds the add command of a saved entry`, `iecode.cliPath stays machine scoped`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** core, then `claudeConnect.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: connect Claude Code to the ADS tools once per user` (why: one user-scope registration instead of one entry per folder, and no secret in the Claude configuration).

---

### Task 8: Docs and end-to-end check

**Files:**
- Modify: `extension/README.md` (the known limits: a modal write dialog cannot be closed, so after a timeout the next write waits until it is dismissed; a paused window gives "did not answer" instead of a fallback; feature row "AI tools for live values": Claude Code via Connect; settings table; "Always Allow" limit for Copilot (R27) and that MCP writes are always confirmed by IECode's dialog while `confirm` is set), `extension/CHANGELOG.md`, `TODO.md` (MCP item done, link spec and plans), `cli/README.md` if Task 5 left gaps

- [ ] **Step 1: Update the docs**, and replace the status note at the top of [2026-11-03-ads-mcp-server.md](2026-11-03-ads-mcp-server.md) by a line saying that its Tasks 1 and 6 to 9 are replaced by this plan.
- [ ] **Step 2: Manual check of the host wiring (built Tasks 2b to 4 of the earlier plan, R19 to R21, R26):** change `iecode.ads.target` while a write waits for the host start → not written; change the target while the host is idle → the watch view shows the symbols as unresolved at once; reload the window while a confirmed write waits for the host start → nothing written; a write whose read-back fails is not stageable on a real PLC, record "not staged".
- [ ] **Step 3: Manual check, F5 session, terminal Claude and Claude Code in VS Code** (the user runs the VS Code part): open two windows first, then Connect once in one of them → the other starts serving without a reload; two windows with different folders each see their own watch list; a variable added by Claude shows up in the view and scope; scope summary; write with off / confirm / auto; Cancel in the dialog; interrupt Claude while the dialog is open, then click Write → nothing written; change the target while the dialog is open → not written; no window open → clear error, then open it and the next call works without restarting Claude; the same folder in two windows → conflict message; close the view, wait 60 s, ask for the scope → gap note; restart VS Code → no new setup; Disconnect → `/mcp` no longer lists `iecode`; with `claude` not on PATH, Connect offers Copy Command. Record the Claude Code and CLI versions in the commit body.
- [ ] **Step 4: Package** `npm run package`, install the VSIX, repeat Connect, a read and one confirmed write.
- [ ] **Step 5: Run** `npm test` and the CLI suites. Expected: green.
- [ ] **Step 6: Commit** `Docs: ADS tools for Claude Code over the MCP bridge`.

---

## Spike results

Measured 2026-11-04 with a stdio spike server (user scope), Claude Code 2.1.306 (terminal, `claude mcp list` health check) and 2.1.318 (VS Code extension). Status: the gate is open (Tasks 4, 5, 7 may start); only the terminal cwd cases stay unmeasured, see Ruling below.

- **Working directory (VS Code extension, single folder):** the workspace folder as VS Code opened it, lower-case drive letter kept (`c:\...\<folder>`). `CLAUDE_PROJECT_DIR` is also set. `claude mcp list` from a terminal: the shell's cwd. Terminal subfolder, junction and multi-root were not measured: the bridge canonicalises the cwd (drive case, links) and matches it against every root, so only "the cwd is the folder the session was opened for" is relied on.
- **Protocol:** `initialize` carries `protocolVersion` `2025-11-25` for both versions; the server echoing it is accepted. Before `initialize` Claude sends a `server/discover` request (`_meta` protocolVersion `2026-07-28`); a `-32601` error reply is accepted. Then `notifications/initialized` and `tools/list` (id 1). Supported versions the bridge echoes: `2025-11-25`.
- **Tool timeout:** a `ping_tool seconds=300` call returned `pong` after 300 s with no timeout (one data point: the timeout is at least 300 s, the real limit is unknown). Task 6: `operationMs = min(150 000, 300 000 - 10 000)` keeps 150 s / 120 s unchanged.
- **Cancel:** interrupting a call sends `notifications/cancelled` with `{ requestId: <number as sent>, reason: "AbortError: remote-cancel" }`; the server process stays alive and the running call is not stopped by the client.
- **Session end:** stdin EOF (no signal seen). The health check starts the server, sends `initialize`/`tools/list` and closes stdin within about a second.
- **ACLs:** `%LOCALAPPDATA%` grants only SYSTEM, Administrators and the owner (inherited). A Node-created pipe has the default DACL: full control for SYSTEM, Administrators, owner; Read for Everyone and ANONYMOUS LOGON. The handshake secret, not the pipe ACL, keeps other users out.
- **Claude locations:** `claude.exe` in `%USERPROFILE%\.local\bin` and `claude`/`claude.cmd` in `%APPDATA%\npm`, both on `PATH` for this user.
- **Empty list and `list_changed` (Step 4):** an empty `tools/list` result removes the tools from the session after a `/mcp` reconnect. With the real list and a `notifications/tools/list_changed` (no `/mcp`), Claude Code calls `tools/list` again within 1 s and the tools are back. So the bridge can start with the `tools.json` or an empty list and announce a window later.
- **Server death:** a hard-killed server is NOT restarted by Claude Code (about 1 minute observed) and the session's tool list stays as it was; only `/mcp` or a reload brings it back. The bridge must therefore never exit while stdin is open.
- **`claude mcp get` (Step 6):** it starts the server itself and probes it, so "Connected" says nothing about the running session. Fixtures: a failing entry prints `Status: ✘ Failed to connect` and `Issue: CONNECTION_CLOSED: Connection closed`; an absent entry prints `No MCP server named "iecode". Configured servers: ...` (not "No MCP server found"); a healthy one prints `Scope:`, `Status: ✔ Connected`, `Type: stdio`, `Command:`, `Args:`, `Environment:` lines. Task 7 treats both absent phrasings as absent.
- **Decision:** pass. Tasks 4, 5, 7 continue. The spike entry was removed from the user scope.

## Eng review 2026-11-03

Target: this plan. The user delegated every decision ("du entscheidest alles"), so the choices below were taken by the reviewer and are listed for the user to check; no per-choice question was asked. Each applied remedy is already in the tasks above.

**Scope Challenge:** scope accepted as-is. Eight tasks, about 20 new files and 8 new classes or modules: over the complexity threshold, but every piece traces to a spec section and the pure/wiring split is what makes the write path testable. Reuse found: `Runner.Action(protocolStdout: true)` (CLI), `adsTools`, `WriteGate`, `McpSession` consumers (extension). Rejected as simpler: a Node bridge shipped in the extension (needs a standalone `node`, path changes per update).

**Reality rows:** `premise-table`: 6 premises checked, 1 FALSE (the plan claimed an existing absolute CLI resolver: `cliPath()` in `extension/src/cli/iecode.ts:49` is private and returns a bare `iecode`; fixed by `resolveIecodeExe`), 3 unverified until the spike (Claude's cwd, protocol version, tool timeout). `already-done`: nothing on `main` touches the bridge. `surface-check`: `Runner.Action` signature, `Program.cs` registration pattern and the `iecode_ads_*` entries in `package.json:1343-1451` verified. `binding-decisions`: D20/D21 and the spec's "decided with the user" section respected. `numbers`: no performance numbers claimed; timeouts are `[estimated]` and set by the spike. `deferred-asks`, `pr-count`: n/a (no linked issue; one branch).

**Architecture (design-twice):** shape 1 (chosen): a thin relay that answers `initialize`, `ping` and the no-window cases itself and forwards the rest; shape 2: a pure byte pipe with selection only, the extension answering everything. Shape 2 is shallower in the bridge but cannot keep the tools visible while no window is open, which the user asked for; shape 1 stays. Red flags: hand-synced constants in two languages → one golden fixture `testdata/mcp-wire.json` read by both suites.

| # | Severity (confidence) | Finding | Disposition |
|---|---|---|---|
| 1 | CRITICAL (9) | "connected" flag in `globalState` is a per-host snapshot: windows open before Connect never start serving, Disconnect never stops them (outside voice H1) | fixed: marker file `connected`, polled every 5 s (Task 3, 6, 8) |
| 2 | CRITICAL (8) | `removeDeadInstances` by another window can erase the file of a busy or debugger-paused window for good (outside voice H2) | fixed: `sweepStaleInstances` only deletes files that are 10 min old and unreachable; owner heartbeat every 60 s |
| 3 | INFORMATIONAL (8) | Pid plus start time cannot be checked from Node | fixed: pipe probe only |
| 4 | INFORMATIONAL (8) | A silent pipe could hang the bridge | fixed: 2 s handshake timeout (bridge), 5 s (extension), parallel probes |
| 5 | CRITICAL (8) | Gate deadlines 120 s / 150 s (`extension.ts:128`) may exceed Claude's tool timeout, so Claude gives up while the dialog is open | fixed: policy derived from the spike's timeout (Task 6) |
| 6 | INFORMATIONAL (9) | `cliPath()` is not an absolute path (premise FALSE) | fixed: `resolveIecodeExe` (Task 7) |
| 7 | INFORMATIONAL (8) | Pipe and discovery logic untested because they sat in the VS Code module | fixed: `core/mcpPipe.ts`, `core/instanceFiles.ts` with tests on a real temporary pipe |
| 8 | CRITICAL (8) | Selection once per session: a later second window or longer root could send a write to an unintended window (outside voice M3) | fixed: re-evaluated before every `tools/call` |
| 9 | INFORMATIONAL (7) | Empty tool list when no window: Claude may never re-list (outside voice M1) | fixed: `listChanged` plus a 5 s search timer; static list in the CLI as the documented fallback after the spike |
| 10 | CRITICAL (8) | `ads_write` through `McpSession` to the gate had no automated test; handling lines serially would queue a cancel behind a waiting write (outside voice M2) | fixed: `core/mcpTools.ts` with tests, concurrency rule and test in Task 2 and 6 |
| 11 | INFORMATIONAL (7) | `claude` may not be on `PATH` for a VS Code-only user (outside voice M4) | fixed: known install locations, "not verified" label |
| 12 | INFORMATIONAL (6) | Spike leaves a user-scope `spike` entry | fixed: Step 6b |
| 13 | INFORMATIONAL (6) | Mutual HMAC is more than the threat model needs (outside voice Low) | rejected: small, already specified, a squatter then learns nothing |
| 14 | INFORMATIONAL (5) | Task 1 listed after Tasks 2 and 3 | rejected as a reorder; the execution order below puts it first |

**Test review:** coverage diagram.

```
CODE PATHS (planned)                                        USER FLOWS
[+] extension/core/mcp.ts (McpSession)                      [+] Claude interrupts a write
  ├── [★★★ planned] tools/list, tools/call, errors            ├── [★★★ planned] cancel while dialog open (Task 2, 6)
  ├── [★★★ planned] cancel, ambiguous id, close               └── [★★★ planned] connection closes → unsent write refused
  └── [★★★ planned] concurrent cancel                      [+] No window / wrong window
[+] extension/core/mcpWire.ts, mcpPipe.ts, instanceFiles.ts   ├── [★★★ planned] no window → error, later found (Task 5)
  ├── [★★★ planned] proof, framing, handshake, golden        ├── [★★★ planned] same folder twice → conflict (Task 4, 5)
  ├── [★★★ planned] real pipe: auth, wrong proof, oversize   └── [★★  manual] longer root later wins (Task 5 unit)
  └── [★★★ planned] sweep, heartbeat, marker               [+] Multi-window
[+] cli/Mcp (Wire, Selection, BridgeHandshake, McpBridge)     ├── [→E2E manual] Connect in A, B starts serving (Task 8)
  ├── [★★★ planned] selection, paths, probes, timeouts       └── [→E2E manual] restart VS Code, no new setup
  └── [★★★ planned] stdout discipline, lost connection
[+] extension/ads/mcpServer.ts, claudeConnect.ts (VS Code)  
  └── [GAP, manual by design] dialog, procKey wiring, Connect against a real claude (Task 6 Step 5, Task 8)

COVERAGE: planned 32/35 paths (91%) | GAPS: 3 (all VS Code or real-Claude wiring, covered by the manual steps of Tasks 6 and 8)
```

Regression risk: the Copilot tools and the write gate are untouched by this plan except `package.json` description text; their 236 tests stay as the guard (Task 6 Step 4 runs them).

**Performance:** no per-request database or loop paths. Bounds: frames 1 MB, handshake 2 s and 5 s, probe cache 5 s, heartbeat 60 s, marker poll 5 s (a `fs.existsSync` per window); 0 issues.

**Failure modes:** window paused in a debugger → probe times out in 2 s, the call fails with "did not answer", nothing is sent elsewhere, the file is kept (tested); Claude session ends mid-write → connection closes, unsent write refused, a sent one keeps its real outcome; CLI older than the extension → clear version error from the bridge; `claude` missing → copy command, state labelled not verified. Critical gaps: 0.

**Second opinion 2026-11-04 (Copilot CLI, gpt-6.1-sol, read the spec, the plan and `writeGate.ts`):** 12 findings, each checked against the plan by the author; the user approved the list ("ja"). Applied: (1) a timed-out window counted as dead, so a paused window with the longest root let a write fall back to a shorter root → three-state probe (`Ok`/`Absent`/`Silent`) and `Selection.Unsure`, which blocks; (2) per-call selection only ran when no call was open → every call is selected on its own; (3) a cancel could be lost while selection or handshake was running → request state and cancel latch before the first `await`, cancel forwarded after its call on the same link; (4) a `tools/call` without id or with a running id was accepted → `-32600`, never forwarded or run; (5) the discovery folder's privacy was only observed in the spike → `aclAllowsOthers`, a repair with `icacls`, and no serving when it stays open; (6) the gate's behavior after a sent write and after a dialog timeout was not stated → documented limit, test that a hanging send ends as `Outcome unknown`, policy helper; (7) start versus stop races → serialized lifecycle with a generation counter; (9) the registration restore only kept the exe → whole entry saved and restored, registration lock, Disconnect only removes an entry that is exactly ours; (11, partly) reply size checked in UTF-8 bytes, one writer per stream, at most 32 open calls. Rejected: (12) `iecode.cliPath` has `scope: machine`, so a workspace cannot set it (a test pins that); (8) a negotiated bridge protocol with a transcript-bound version is more than v1 needs, a wire version range and an update error stay; (10) one shared `tools.json` across two installed extension versions is a rare case, it is written atomically and the bridge re-reads it on every `tools/list` (a catalog change while a window is selected is not announced; the next `tools/list` shows it).

**NOT in scope:** negotiated bridge protocol with transcript binding; a versioned per-extension tool catalog with `list_changed` on window switches; other MCP clients; remote, WSL and container hosts; keeping the host sampling while Claude is connected (decided with the user); an ACL change by the CLI (only if the spike shows the directory is readable by other users); `fs.watch` instead of polling (builder's call).

**What already exists:** `adsTools`, `adsWriteGate`, `PreparedWrites`, `parse*Input`, `capText`, `writeResultText` (built on this branch); `Runner.Action(..., protocolStdout: true)` and the `ads serve` stdin loop pattern (`TargetCommands.cs:97-135`); `customCliPath` and `INSTALL_DIR` (`extension/src/cli/iecode.ts`).

**Worktree parallelization:**

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| Task 1 spike | none (scratchpad) | — |
| Tasks 2, 3 | extension/core | — |
| Tasks 4, 5 | cli/IECode.Core, cli/IECode.Cli | Task 1 (5 also needs 4) |
| Task 6 | extension/core, extension/ads | Tasks 1, 2, 3 |
| Task 7 | extension/core, extension/ads, extension/cli | Task 5 (CLI `mcp --help`), Task 6 |
| Task 8 | docs | all |

Lane A: Task 2 → 3 (extension/core). Lane B: Task 4 → 5 (cli). Launch the spike first, Lane A may run beside it; Lane B and Task 6 wait for the spike. Merge both lanes, then Task 6, Task 7, Task 8. No shared files between lanes except `testdata/mcp-wire.json`, created in Lane A and read by Lane B, so Task 3's fixture commit goes first.

**Implementation Tasks:** T1 (P1, human ~2h / CC ~20min) the spike; T2 (P1) Task 2 and 3 pure modules; T3 (P1) Tasks 4 and 5 bridge; T4 (P1) Task 6 including `mcpTools` seam tests; T5 (P2) Task 7; T6 (P2) Task 8 docs and manual checks. All derive from the findings above; no new tasks beyond the plan.

**Unresolved decisions:** none in this review. Open until the spike: the working directory Claude gives the bridge (hard gate), the tool timeout, whether Claude re-lists tools.

**Outside voice:** native fallback (Plan subagent; Codex CLI not installed): completed, 5 findings applied, 1 rejected, 1 reorder rejected.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native Plan subagent (Codex not installed) | Independent 2nd opinion | 1 | unavailable as external; native completed | 12 findings, 11 applied |
| Second Opinion | Copilot CLI (gpt-6.1-sol) | Cross-model check | 1 | 12 findings: 9 applied in full or part, 3 rejected with reason | 5 critical, 7 medium |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues found, all resolved in the plan | 14 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** native subagent plus one external model (Copilot CLI); Codex CLI is not installed.
**VERDICT:** ENG CLEARED for implementation once the spike (Task 1) passes; the user delegated all decisions, so they are listed above for checking.

NO UNRESOLVED DECISIONS
