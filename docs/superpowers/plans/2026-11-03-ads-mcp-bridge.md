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
- Discovery directory `%LOCALAPPDATA%\iecode\mcp\v1\` (`instances\<id>.json`, `tools.json`); pipe `\\.\pipe\iecode-mcp-<id>`; frames are newline-delimited UTF-8 JSON, at most 1 048 576 bytes per line; the secret is never sent.
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
- [ ] **Step 6: `claude mcp get spike`** output (server up and down); save it as the fixture for Task 7's `registeredExe` test.
- [ ] **Step 7: Decide and commit.** Pass: continue with Task 4. Fail: stop and bring the findings and the two fallbacks of the spec (per-project registration with a folder argument, or the HTTP design) to the user. Commit `Docs: spike results for the ADS MCP stdio bridge` (why: the working directory and ACL facts decide the design).

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
    constructor(tools: McpTool[]);
    handle(line: string): Promise<string | undefined>;   // one MCP line in; the reply line, undefined for notifications
    close(): void;                                       // connection closed: aborts every running call
  }
  ```
  Methods: `tools/list` → `{ tools: [{ name, description, inputSchema }] }`; `tools/call` → `{ content: [{ type: 'text', text }], isError }` (unknown tool → `-32602`); `ping` → `{}`; `notifications/cancelled` → abort the running call with that `requestId`, but only if exactly one running call has that id (R14); other notifications → no reply; unknown method with an `id` → `-32601`; invalid JSON → `-32700`; a JSON array (batch) or a message without `method` → `-32600`. A tool that throws gives a tool result with `isError: true`, never a crash. `initialize` is answered by the bridge, not here.

- [ ] **Step 1: Write failing tests:** `tools/list lists the tools`, `tools/call returns text content`, `tools/call marks errors`, `unknown tool gives -32602`, `unknown method gives -32601`, `notification gets no reply`, `invalid JSON gives parse error`, `batch gives invalid request`, `cancelled notification aborts the running call`, `cancelled with an ambiguous id aborts nothing` (two running calls with id 5), `close aborts every running call`, `a throwing tool gives an error result`.
- [ ] **Step 2: Run** `cd extension && npm test`. Expected: the new tests FAIL (module missing).
- [ ] **Step 3: Implement** `McpSession`; JSON-RPC ids may be numbers or strings, keep them as given.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: MCP session for the ADS tools` (why: hand-written to keep the extension free of runtime dependencies; transport-independent so a fallback can reuse it).

---

### Task 3: Wire contract, extension side (pure)

**Files:**
- Create: `extension/src/core/mcpWire.ts`
- Test: `extension/test/mcpWire.test.ts`

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
  ```

- [ ] **Step 1: Write failing tests:** `proof differs per role`, `proofMatches rejects different lengths`, `framer splits lines across chunks`, `framer throws on a line over the limit`, `handshake accepts the right bridge proof and replies with the ext proof`, `handshake fails on a wrong proof`, `handshake fails on a malformed line`, `canonicalRoot ignores drive case and trailing separator` (inject `realpath`), `canonicalRoot resolves through realpath`. Pin one proof value for `proof('c2VjcmV0','bridge','AAAA','BBBB')` as a golden string, computed once with an independent tool (PowerShell `System.Security.Cryptography.HMACSHA256`); the C# side asserts the same string (Task 4).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:crypto` (`createHmac`, `timingSafeEqual`, `randomBytes`).
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
  public sealed record InstanceInfo(string Id, int Pid, string ExtensionVersion, int ProtocolMin, int ProtocolMax,
    string Pipe, IReadOnlyList<string> Roots, string WorkspaceName, string Secret);
  public static class Instances { public static IReadOnlyList<InstanceInfo> Load(string instancesDir); }  // unreadable or format != 1 files are skipped
  public static class PathMatch { public static string Canonical(string path); public static bool Contains(string root, string path); }
  public abstract record Selection {
    public sealed record Chosen(InstanceInfo Instance, Stream Link) : Selection;
    public sealed record None : Selection;
    public sealed record Conflict(IReadOnlyList<InstanceInfo> Instances) : Selection;
    public sealed record VersionMismatch(InstanceInfo Instance) : Selection;
    public static Selection Choose(string cwd, IReadOnlyList<InstanceInfo> all, Func<InstanceInfo, Stream?> connect);
  }
  ```
  `connect` does the pipe connect and the handshake and returns the authenticated stream, or null when the instance is not usable. `Choose`: candidates are instances with a root that `Contains` the canonical `cwd`; group by the length of their best root; walk the groups from the longest; the first group with at least one instance whose `connect` returns a stream decides (one → `Chosen`, more than one → `Conflict` and every opened stream is disposed); an instance whose protocol range excludes `Wire.Protocol` yields `VersionMismatch` when nothing else is usable; no usable candidate → `None`.

- [ ] **Step 1: Write failing tests** (`McpWireTests`): `proof matches the golden value of the extension` (same string as Task 3), `proofMatches rejects different lengths`, `framer splits lines across chunks`, `framer throws on a line over the limit`, `framer decodes UTF-8 split across chunks`.
- [ ] **Step 2: Write failing tests** (`McpSelectionTests`, `connect` is a fake): `canonical path ignores drive case and trailing separator`, `plant does not match plant-old`, `a subfolder of a root matches`, `longest root wins`, `a multi-root instance matches through any root`, `two live instances with the same best root are a conflict` (streams disposed), `a dead instance is neither match nor conflict`, `a dead instance with the longest root falls back to the next group`, `no candidate gives None`, `protocol range without 1 gives VersionMismatch`, `unreadable instance file is skipped`, `a format 2 file is skipped`.
- [ ] **Step 3: Run** `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~Mcp"` (PowerShell tool). Expected: FAIL (types missing).
- [ ] **Step 4: Implement.** `Canonical`: `Path.GetFullPath`, resolve the final link target of every existing component with `FileSystemInfo.ResolveLinkTarget(true)`, backslashes, trailing separator removed, compare ordinal-ignore-case (Windows only). `Contains`: same folder or an ancestor, component by component.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `CLI: MCP bridge core, window selection and wire contract` (why: selection is where a wrong guess writes to the wrong PLC window, so it is pure and tested before any process exists).

---

### Task 5: `iecode mcp` command

**Gate: Task 1 passed.**

**Files:**
- Create: `cli/src/IECode.Core/Mcp/McpBridge.cs`, `cli/src/IECode.Cli/Commands/McpCommand.cs`, `cli/tests/IECode.Core.Tests/McpBridgeTests.cs`
- Modify: `cli/src/IECode.Cli/Program.cs:24` (register `McpCommand.Create()`), `cli/README.md` (the command, the discovery directory, the protocol range)

**Interfaces:**
- Consumes: Task 4 (`Instances.Load`, `Selection.Choose`, `Wire`, `LineFramer`).
- Produces:
  ```csharp
  public sealed class McpBridge {
    public McpBridge(string cwd, string instancesDir, string toolsFile, Func<InstanceInfo, Stream?> connect,
                     Stream stdin, Stream stdout, Action<string> log);
    public Task RunAsync(CancellationToken ct);   // returns when stdin closes
  }
  internal static class McpCommand { public static Command Create(); }  // `iecode mcp`, Action(..., protocolStdout: true)
  ```
  Behaviour: `initialize` → result with the client's `protocolVersion` echoed if it is one of the versions the spike found, else the newest of them, `capabilities: { tools: {} }`, `serverInfo: { name: "iecode", version }`; `notifications/initialized` and `ping` answered or ignored locally. `tools/list`, `tools/call`, `notifications/cancelled`: select once per session (`Selection.Choose` with `Instances.Load` and the real pipe `connect`: `NamedPipeClientStream(".", pipe, InOut, Asynchronous)`, 500 ms connect timeout, handshake of the Wire contract) and forward the line unchanged; replies are matched by JSON-RPC id. Stdin is read concurrently with open calls, so a `notifications/cancelled` is forwarded at once. Selection is repeated at the next call while no link is open. Without a window, `tools/list` returns `tools.json` (or an empty list when the file is missing) and `tools/call` returns a tool error `No VS Code window with IECode is open for <cwd>. Ask the user to open the folder in VS Code.`; `Conflict` → tool error `workspace <name> and workspace <name> both serve <folder>`; `VersionMismatch` → tool error naming which side (CLI or extension) to update. A link that breaks with calls open gives each of them the tool error `The connection to IECode was lost during the call, so it may or may not have run. Read the state before acting; for a write, read the variable and ask the user.` and is never re-sent. Stdout carries only MCP lines; everything else goes to `log` (stderr).
  `McpCommand` resolves `cwd = Directory.GetCurrentDirectory()`, `instancesDir = %LOCALAPPDATA%\iecode\mcp\v1\instances`, `toolsFile = ...\tools.json`.

- [ ] **Step 1: Write failing tests** with in-memory streams and a fake `connect`: `initialize is answered without a window`, `ping is answered without a window`, `tools/list forwards to the window`, `tools/list falls back to tools.json without a window`, `tools/list is empty without a window and without tools.json`, `no window gives a tool error naming the folder`, `a window that appears later is found`, `conflict gives a tool error naming both workspaces`, `version mismatch names the side to update`, `cancel is forwarded while a call is open`, `lost connection during a call is reported and not replayed`, `reply goes to the call with the same id`, `stdout carries only MCP lines` (a log call and a failing connect leave stdout parseable line by line), `exits when stdin closes`.
- [ ] **Step 2: Run** `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~McpBridge"`. Expected: FAIL.
- [ ] **Step 3: Implement** `McpBridge` and `McpCommand`; `Console.Out` is replaced by the protocol stream only in the command, the class takes streams.
- [ ] **Step 4: Run** the filter, then the whole CLI suite (`dotnet test cli/tests/IECode.Core.Tests`, then `cli/tests/IECode.Automation.Tests`, one after the other). Expected: all PASS.
- [ ] **Step 5: Commit** `CLI: iecode mcp relays MCP lines to the window that serves the folder` (why: a user-scope stdio entry replaces per-folder HTTP registration; the relay stays free of ADS and write rules).

---

### Task 6: The extension serves a window

**Gate: Task 1 passed.**

**Files:**
- Create: `extension/src/ads/mcpServer.ts`
- Modify: `extension/src/extension.ts:128-131` (create the server next to the gate, dispose it), `extension/src/views/adsWatch.ts` (description gains `MCP: on`), `extension/package.json` (rewrite the five `modelDescription`s and the `aiWrites` description and picker text so they hold for both clients: no `#adsWatch`/`adsScope` names, per-client approval detail out of the tool text; `lmTools.ts` keeps its Copilot-only hint in `prepareInvocation`)
- Test: manual (VS Code module); pure parts are covered by Tasks 2 and 3.

**Interfaces:**
- Consumes: `adsTools(ctx, state, MCP_NAMES)`, `adsWriteGate` / `WriteGate.run`, `parse*Input`, `writeResultText`, `writeResultIsError` (built); `McpSession` (Task 2); `ExtHandshake`, `LineFramer`, `canonicalRoot`, `toolsFile`, `InstanceFile` (Task 3).
- Produces:
  ```ts
  export class AdsMcpServer implements vscode.Disposable {
    constructor(ctx: vscode.ExtensionContext, state: WorkspaceState, gate: WriteGate);
    start(): Promise<void>;        // pipe, then the instance file; no-op unless `connected()`
    stop(): Promise<void>;         // closes connections, deletes the instance file
    serving(): boolean;
    connected(): boolean;          // globalState key `iecode.mcp.connected`
    setConnected(on: boolean): Promise<void>;   // starts or stops
    readonly onState: vscode.Event<void>;
  }
  ```
  Per connection: `ExtHandshake`, then each line into one `McpSession` built from the five tools (descriptions and `inputSchema` read from `ctx.extension.packageJSON.contributes.languageModelTools`, names `ads_*`); `ads_write` → parse → `gate.run({ symbol, value, targetKey: host.targetKey(), via: 'MCP' }, signal)` → `writeResultText`, `isError` from `writeResultIsError`. A closing connection calls `session.close()` (every unsent write of the session is refused). A line over `MAX_FRAME` closes the connection. At start: delete instance files of dead instances (pid and `startedAt` check, best effort), write `tools\.json` from `toolsFile`, create the pipe `iecode-mcp-<id>` with `net.createServer`, then write the instance file atomically; rewrite it with `rootsRevision + 1` on `onDidChangeWorkspaceFolders`; delete it in `stop()`. A listen or write error: one warning `IECode: the MCP server for Claude Code could not start: <reason>`, nothing else breaks.

- [ ] **Step 1: Implement** `mcpServer.ts` and the wiring; rewrite the `package.json` texts.
- [ ] **Step 2: Run** `npm test`. Expected: green (compiles, nothing regresses).
- [ ] **Step 3: Manual check, F5 session, no Claude needed:** set `iecode.mcp.connected` in the Extension Development Host (`ctx.globalState`, temporary command or debug console), see the instance file appear under `%LOCALAPPDATA%\iecode\mcp\v1\instances\`, then drive the contract by hand with a small Node client script in the scratchpad: handshake with the secret from the file, `tools/list`, `tools/call` `ads_read` of a watched variable; wrong secret → connection closed without reply; kill the Extension Development Host → file stays, pipe dead (Task 4 treats it as dead).
- [ ] **Step 4: Commit** `Extension: serve the ADS tools of a window over a named pipe` (why: the bridge needs a per-window endpoint that other users and browsers cannot use without the secret).

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
  export function cmdLine(args: string[]): string;       // cmd.exe line for claude.cmd; throws on cmd metacharacters (R1)
  export function findOnPath(pathEnv: string, exists: (p: string) => boolean): { exe?: string; cmd?: string }; // absolute PATH entries only (R12)
  ```
- Produces (ads): `registerClaudeConnect(ctx, server: AdsMcpServer)` with the two commands.
  Connect: refuse with a message when `vscode.env.remoteName` is set or the platform is not Windows. Resolve the CLI with the existing resolver of `extension/src/cli/iecode.ts` (`iecode.cliPath`, else the installed CLI); run `iecode mcp --help`: failure → message pointing at "IECode: Install CLI". Resolve `claude` with `findOnPath` and spawn its absolute path with an argument array (`claude.exe` first; `claude.cmd` through `cmd.exe /d /s /c` and `cmdLine`, `windowsVerbatimArguments`, R1, R12). If `getArgs` shows an `iecode` entry, `removeArgs` then `addArgs`, and restore the old entry when the add fails; on failure report exit code and output, leave `connected` false. After success `server.setConnected(true)` and tell the user: `Claude Code connected. A running Claude session needs /mcp to reconnect or a restart. AI writes are currently "<value>"; change with "IECode: Set AI Write Access…".` `claude` not found: offer `Copy Command` (`manualCommand`) and set `connected` only after the user confirms they ran it.
  Disconnect: `removeArgs` when `registeredExe` is the iecode.exe this extension resolves; `server.setConnected(false)`. `globalState` has no change event across windows, so a serving window re-reads the flag every 5 s and stops serving (and deletes its instance file) once it is false; the interval is the builder's call.

- [ ] **Step 1: Write failing tests:** `addArgs builds the user-scope stdio registration`, `registeredExe reads the command of the entry` (fixture from the spike), `manualCommand quotes the path`, `cmdLine quotes arguments and refuses metacharacters` (R1), `findOnPath ignores the current folder and relative entries` (R12).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** core, then `claudeConnect.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: connect Claude Code to the ADS tools once per user` (why: one user-scope registration instead of one entry per folder, and no secret in the Claude configuration).

---

### Task 8: Docs and end-to-end check

**Files:**
- Modify: `extension/README.md` (feature row "AI tools for live values": Claude Code via Connect; settings table; "Always Allow" limit for Copilot (R27) and that MCP writes are always confirmed by IECode's dialog while `confirm` is set), `extension/CHANGELOG.md`, `TODO.md` (MCP item done, link spec and plans), `cli/README.md` if Task 5 left gaps

- [ ] **Step 1: Update the docs**, and replace the status note at the top of [2026-11-03-ads-mcp-server.md](2026-11-03-ads-mcp-server.md) by a line saying that its Tasks 1 and 6 to 9 are replaced by this plan.
- [ ] **Step 2: Manual check of the host wiring (built Tasks 2b to 4 of the earlier plan, R19 to R21, R26):** change `iecode.ads.target` while a write waits for the host start → not written; change the target while the host is idle → the watch view shows the symbols as unresolved at once; reload the window while a confirmed write waits for the host start → nothing written; a write whose read-back fails is not stageable on a real PLC, record "not staged".
- [ ] **Step 3: Manual check, F5 session, terminal Claude and Claude Code in VS Code** (the user runs the VS Code part): Connect once; two windows with different folders each see their own watch list; a variable added by Claude shows up in the view and scope; scope summary; write with off / confirm / auto; Cancel in the dialog; interrupt Claude while the dialog is open, then click Write → nothing written; change the target while the dialog is open → not written; no window open → clear error, then open it and the next call works without restarting Claude; the same folder in two windows → conflict message; close the view, wait 60 s, ask for the scope → gap note; restart VS Code → no new setup; Disconnect → `/mcp` no longer lists `iecode`; with `claude` not on PATH, Connect offers Copy Command. Record the Claude Code and CLI versions in the commit body.
- [ ] **Step 4: Package** `npm run package`, install the VSIX, repeat Connect, a read and one confirmed write.
- [ ] **Step 5: Run** `npm test` and the CLI suites. Expected: green.
- [ ] **Step 6: Commit** `Docs: ADS tools for Claude Code over the MCP bridge`.

---

## Spike results

(Filled in by Task 1.)
