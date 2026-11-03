# ADS MCP server for Claude Code: design

Date: 2026-11-03. Status: bridge revision, draft for review. This revision replaces the HTTP transport with per-folder
registration by a user-scope stdio bridge (decisions D20/D21 of the plan's decision ledger). The tool logic, write
rules and write outcomes were not changed by it.

## Intent

The user debugs PLC code together with an AI, either on the local machine or on a simulation machine reachable over
ADS. The AI should be able to add variables to the ADS watch list on its own, read them, write them and look at their
history in the sample buffer (ring buffer). Copilot can already do this through the `vscode.lm` tools in
[extension/src/ads/lmTools.ts](../../../extension/src/ads/lmTools.ts). Most of the daily AI work is done with Claude Code
in its VS Code extension, which cannot call `vscode.lm` tools. This design gives Claude Code the same five tools through
an MCP server.

How the user works (said in the design conversation): several VS Code windows can be open at once, each with Claude
Code and often several chats. When debugging, the chats of one window mostly point at the same ADS target; different
windows may point at different targets (local or a simulation machine).

## Goals

- Claude Code gets the five ADS tools with the same behaviour as the Copilot tools: `symbols`, `watch`, `read`,
  `scope`, `write`.
- One shared state: the MCP tools work on the same `AdsHost` (watch list, sample buffer, ADS connection) as the ADS
  Watch view, the ADS Scope and the Copilot tools of the window they are served from. A variable Claude adds shows up in
  the view and the scope at once. Several chats of one window share that state.
- One setup per Windows user, not per project: `claude mcp add -s user iecode -- <absolute path of iecode.exe> mcp`,
  run by the command "IECode: Connect Claude Code" or by hand. After that every window that is served finds its own
  tools by its folder.
- The same write rules as before: `iecode.ads.aiWrites` off / confirm / auto, read from the user settings only, and
  confirm instead of auto while the workspace settings redirect the target or port (`workspaceTarget()`).
- With `confirm`, IECode shows its own modal VS Code dialog with variable, value, target and workspace name. Claude
  Code's own tool permission prompt comes on top of that; IECode does not rely on it.

## Non-goals

- No new ADS features beyond what the Copilot tools do today.
- No change to the ADS Watch view, the ADS Scope or the sample buffer, except a short status hint.
- No MCP server without VS Code: tools are served by the extension host of a window and are available only while that
  window is open.
- No support for other MCP clients than Claude Code as a goal; others may work, nobody tests them.
- No remote, WSL or container extension host: only the local Windows topology.
- No automatic choice between two windows that serve the same folder (see Selection).

## Anti-goals (failure even if it works)

- A web page in a browser, another Windows user on the machine, or a blind probe of a name or port can read or write PLC
  variables through the bridge or the extension's listener. Processes of the same Windows user are out of scope on
  purpose (decided with the user): they can read the discovery files, and they could write the PLC over the TwinCAT
  router without IECode anyway.
- A secret ends up in the repository, in `~/.claude.json`, or in a log.
- A write goes to a window or target other than the one the user confirmed, or Claude gets "Not written" for a value
  that reached the PLC.
- Claude silently works on the wrong window: two windows serve the same folder and the bridge picks one.
- The bridge grows into a second implementation of the tools or the write rules.
- Auto-approve applies to a target that a cloned repository chose.
- The Copilot tools and the MCP tools drift apart in behaviour because the logic is duplicated.

## Constraints

- The extension has no runtime dependencies: plain `tsc`, `vsce package --no-dependencies`. The CLI is a .NET tool with
  no MCP dependency either; the bridge's protocol part is hand-written and small.
- The repository is public: no internal names, links or data in code, tests, docs or commits.
- `AdsHost` is per window; the watch list is per workspace (`workspaceState`). The CLI (`iecode.exe`) and the extension
  are versioned and installed separately, so the bridge and the extension must tolerate different versions.
- Claude Code starts a stdio MCP server as a child process per session and reads MCP frames from its stdout; anything
  else on stdout breaks the session. Logging goes to stderr.
- Claude Code shows MCP elicitation dialogs only in interactive terminal sessions, so they are no way to confirm a write
  in the VS Code extension of Claude Code.
- Not verified yet (the spike decides): the working directory Claude Code gives a stdio server (terminal and VS Code
  extension), the protocol revision it speaks, its tool timeout and what an interrupt sends, and what happens to the
  child on session end.

## Decided with the user

- MCP, not a CLI plus skill. Reason: the state (watch list, buffer, connection) lives in the running extension; MCP also
  gives per-tool permissions in Claude Code (`mcp__iecode__ads_write` apart from the read tools).
- Transport towards Claude Code: a stdio bridge, `iecode mcp`, registered once at user scope (D20, user chose it over
  keeping HTTP). The bridge finds the window that serves its working directory through a discovery file.
- A separate IECode confirmation dialog in VS Code for writes with `confirm`.
- Sampling stays demand-driven: a connected Claude does not keep the host running; Claude gets a note about gaps.
- Processes of the same Windows user are outside the threat model.
- Selection and failure behaviour (design conversation): no window found: the tools stay visible and every call gives a
  clear error, found again later without restarting Claude; the same folder served twice: refuse with a message naming
  the conflict; a working directory inside a workspace folder matches that folder, the longest match wins.

The rest of this document is my design on top of that; the builder may refine it, and anything marked "my call" is open
to the reviewer.

## Design

### Overview

```
Claude Code ──stdio──▶ iecode mcp (bridge, .NET) ──named pipe──▶ extension host of one window ──▶ AdsHost
                          │                                          ▲
                          └─ reads discovery files ──────────────────┘ writes one file per window
```

- The **bridge** (`iecode mcp`, part of the CLI) is a thin relay. It owns: choosing the window, authenticating to it,
  forwarding frames, and the answers when there is no window. It knows no ADS, no write rules and no tool logic.
- The **extension** serves one pipe per window and runs the MCP tool handling (JSON-RPC `tools/list`, `tools/call`)
  on top of the shared tool functions and the write gate (`adsTools`, `adsWriteGate`, already built).

### Bridge

- Reads JSON-RPC messages from stdin (newline-delimited JSON, as Claude Code's stdio transport defines it), writes only
  MCP messages to stdout, logs to stderr. Exit when stdin closes.
- Answers itself, without a window: `initialize` (server name `iecode`, capability `tools`), `notifications/initialized`,
  `ping`. My call: this keeps the session alive while no window is found and keeps protocol revision negotiation in one
  place. Which revision to offer is fixed after the spike.
- Forwards `tools/list`, `tools/call` and `notifications/cancelled` to the selected window and relays the replies by
  JSON-RPC id. It keeps reading stdin while a call is open, so a cancellation notification is forwarded at once.
- Without a window: `tools/list` returns the tool list from a cache file the extension writes next to the discovery files
  (`tools.json`: names, descriptions, input schemas, built from `package.json` at each start; my call). Without that file
  it returns an empty list. `tools/call` returns a tool error: "No VS Code window with IECode is open for
  `<cwd>`. Ask the user to open the folder in VS Code." The bridge looks for a window again at every call, so opening the
  window later is enough. A window that appears does not need a Claude restart.
- A call whose connection breaks after it was forwarded gets this error: "The connection to IECode was lost during the
  call, so it may or may not have run. Read the state before acting; for a write, read the variable and ask the user."
  The bridge never re-sends a `tools/call` on a new connection.
- Version handling: the discovery file carries the range of bridge protocol versions the extension speaks; the bridge
  carries its own. No overlap gives a tool error that says which side to update (CLI or extension).

### Discovery

- One file per extension-host instance in `%LOCALAPPDATA%\iecode\mcp\v1\instances\<instance id>.json`; no shared
  registry file, so windows never read-modify-write the same file. `tools.json` lives one level up.
- Fields: file format version, random instance id, pid and process start time, extension version, bridge protocol
  version range, pipe name, canonical workspace root folders, workspace name, a root revision counter, and a random
  per-instance secret.
- Written atomically (temp file, rename) after the pipe is listening; rewritten when the workspace folders change;
  deleted on dispose. At start the extension removes files of instances that are gone (pid plus start time), best effort.
- A file is only a candidate. Whether an instance is alive is decided by the authenticated handshake, not by the pid.
- Protection: the directory is created under `%LOCALAPPDATA%`, which Windows protects for the user by default; the
  extension does not change ACLs. My call: no ACL work in the CLI. The spike records the effective ACL of the directory.
  If another user can read it, the design falls back to the open question "who sets the ACL" (see Left to the builder).

### Selection

- Both sides compare canonical paths: drive-letter case, separators, `.` / `..`, and resolved junctions or symlinks.
- A workspace root matches the bridge's working directory when it is the same folder or an ancestor, compared component
  by component (`C:\work\plant` does not match `C:\work\plant-old`). Among the matches of all instances, the longest
  root wins (a multi-root window matches through any of its roots).
- If the best match exists in more than one instance, every call returns a tool error naming the conflict ("workspace
  `<name>` and workspace `<name>` both serve `<folder>`") and nothing is sent. "Newest window wins" is never used.
- The bridge stays connected to the instance it chose while that instance answers. If it is gone, the next call selects
  again.

### Pipe and authentication

- The extension listens on a Windows named pipe `\\.\pipe\iecode-mcp-<instance id>` created with `node:net`. The instance
  id is random and appears only in the discovery file.
- Handshake on every new connection, before any MCP frame: the extension sends a random nonce and its protocol
  version; the bridge answers with its own nonce, its version and HMAC-SHA256 over both nonces keyed with the instance
  secret; the extension verifies in constant time and answers with the HMAC over the same data in the other direction.
  The secret itself is never sent, so a squatter on the pipe name cannot learn it, and the extension does not talk to a
  bridge that does not know it. Failed handshakes close the connection without detail. (My call; the alternative, a
  loopback HTTP channel, was weighed: a Node-created pipe cannot get an explicit ACL, but the secret in a user-private
  directory and the random name already cover other users, and a browser cannot open a pipe at all. The spike confirms
  the pipe's effective ACL; if another user can connect and read, the design stays valid because they still need the
  secret.)
- Frames are newline-delimited JSON, one MCP message per line, size-limited (my call: 1 MB; a longer line closes the
  connection).
- Each connection is one Claude session. A connection that closes cancels every write of that session that was not yet
  sent.

### MCP handling in the extension

- Supported: `tools/list`, `tools/call`, the notification `notifications/cancelled`, plus `ping`. Everything else gets
  JSON-RPC "method not found"; notifications never get a response. Malformed JSON, wrong envelopes and invalid tool
  arguments give JSON-RPC or tool errors, never a crash.
- MCP tool names: `ads_symbols`, `ads_watch`, `ads_read`, `ads_scope`, `ads_write` on the server `iecode`, so Claude Code
  shows `mcp__iecode__ads_*`.
- Descriptions and input schemas come from the `languageModelTools` entries in `extension/package.json`, read at runtime
  from `ctx.extension.packageJSON`; one source for both clients, with names per client (`MCP_NAMES`, `COPILOT_NAMES`;
  built).
- The tool logic is the shared code already extracted (`adsTools`, `parse*Input`, `capText`, `writeResultText`); the
  protocol layer maps results to `content: [{ type: "text", text }]` and sets `isError: true` for failed calls and for
  `refused` or `unknown` writes (`writeResultIsError`).
- Sampling stays demand-driven (decided with the user). The host samples while the ADS Watch view or the scope is open,
  or while a tool call holds a lease, and stops 30 s after the last use. Scope and read results carry a gap note and the
  age of values (built).

### Writes

The write gate is built and reviewed (queue, per-op latched state, binding to the confirmed target, injected clock,
deadlines, outcomes). What this revision changes is only where cancellation comes from:

- `off`: refused with the Copilot text. `confirm`, or `auto` while `workspaceTarget()` is true: one modal dialog per
  write, naming symbol, value, target and workspace; `auto` otherwise: no dialog. All AI writes of a window, from MCP
  and Copilot, take the same queue and show one dialog at a time.
- Until a write is sent to the host, a cancelled request guarantees no write. Cancelled means: a
  `notifications/cancelled` for the request, the pipe connection closing (the bridge ends when Claude's session ends or
  stdin closes), extension shutdown, or a deadline (dialog or operation). A later click on "Write" then writes nothing;
  IECode shows "was not written: …". Once the value is sent, cancellation cannot take it back.
- Three outcomes are told apart: not written (only with proof that nothing was sent), written (with the value read back,
  or "could not be read back"), and outcome unknown. The unknown text tells Claude not to write again on its own but to
  read the variable and ask the user.
- Every write is logged in the IECode output, marked as MCP or Copilot.
- Copilot's "Always Allow" can skip Copilot's own confirmation; this is a documented limit (README), not a change here.

### Setup and lifecycle

- The user-scope registration and the serving of windows are separate things (my call):
  - "IECode: Connect Claude Code" registers `iecode` once for the Windows user: it runs
    `claude mcp add -s user iecode -- <absolute path of iecode.exe> mcp`, with an argument array (never a shell string),
    and finds `claude` itself (the `.cmd` shim on Windows needs the
    same care as the plan's `findOnPath`). If `claude` is not found it offers to copy the command. An existing `iecode`
    entry is replaced only once the new one can be written.
  - The extension serves a window (pipe, discovery file) only while the user-level flag "connected" is set (global state).
    Connect sets it after a successful registration, or after the user confirms they registered by hand. A user who never
    connected opens no pipe and writes no files.
  - "IECode: Disconnect Claude Code" removes the user-scope registration and the flag; all windows stop serving and delete
    their discovery files. My call: one switch for the user, not one per window.
- The registered path is the absolute path of the installed `iecode.exe` (not a bare `iecode`, which depends on the
  `PATH` of whoever starts Claude). If the CLI is installed somewhere else later, Connect again.
- After a new registration the user is told that running Claude sessions need `/mcp` reconnect or a restart.
- Status: the ADS Watch view description shows "MCP: on" next to "AI writes: …" while the window serves (it says serving,
  not that Claude is connected). Remote, WSL and container hosts: Connect refuses with a message.

### Errors

- The pipe could not be created or the discovery file not written: one warning with the reason; the Copilot tools keep
  working.
- Tool errors (host does not start, PLC unreachable) come back as tool results with `isError: true`, same text as for
  Copilot.

## Already built (Tasks 2 to 5, branch `ph/ads-mcp-server`)

Shared tool logic and Copilot wiring, the buffer reset on a target change, the host write stages and outcomes (also in
the CLI: `ads serve` tells a failed read-back from a write that was not sent), the write gate with `PreparedWrites`,
and the input validation. This revision builds the transport on top of them.

## First step: go/no-go spike

Before the plan is rewritten, a throwaway spike (about 1 hour) checks, with the installed Claude Code in the terminal
and in the VS Code extension:

- a stdio server registered with `claude mcp add -s user` connects, and which working directory it gets: a project root,
  a subfolder, a lower-case drive letter, a junction, a multi-root workspace;
- which protocol revision and which methods Claude Code sends; what an interrupt sends; the tool timeout of a long call;
  what happens to the child process when the session ends (stdin EOF, kill);
- how the tool list looks when the server returns an empty or a cached list, and whether Claude Code reconnects after
  the server was restarted;
- the effective ACL of a Node-created named pipe (`Get-Acl \\.\pipe\…` or `accesschk`) and of
  `%LOCALAPPDATA%\iecode`, and whether a second Windows user could read the discovery directory.

If the working directory is not usable, the fallback is decided with the user then; candidates are a per-project
registration with an explicit folder argument, or the HTTP design of the previous revision.

## Testing

- Bridge (C#, no VS Code): framing and stdout discipline; the replies it gives without a window; selection (canonical
  paths, containment, longest root, tie, stale files, a dead instance); handshake failure, version mismatch; cancel
  forwarding; lost connection during a call; no re-send.
- Extension, pure parts (`node --test`): the JSON-RPC handling (`tools/list`, `tools/call`, unknown method, malformed
  input, notifications without response); the handshake and framing over a temporary pipe; the discovery writer (atomic,
  rewritten on folder change, removed on dispose); the connection-close cancellation of unsent writes.
- Write path and input validation: covered by the built tests; add the new cancellation source.
- Manual check with Claude Code in the VS Code extension and in the terminal, two windows with different folders and
  one with the same folder twice: connect once, both windows see their own tools, a variable added by Claude shows up in
  the view and scope, write with off / confirm / auto, decline, interrupt Claude while the dialog is open, no window
  open (clear error, then open it without restarting), same folder in two windows (conflict message), restart VS Code
  without new setup. Record the Claude Code and CLI versions. Repeat the main checks with the packaged VSIX. The
  wiring that unit tests cannot reach (the child-process key, the no-`await` window before the write, the dialog)
  is also checked by hand here.
- README: the setup, the "Always Allow" limit for Copilot (R27), and that MCP writes are always confirmed by IECode's
  dialog while `confirm` is set.

## Settled after the builder check (my calls)

- **The spike is a hard gate for the bridge code.** Pass: a stdio server registered at user scope starts in the terminal
  and in the VS Code extension and gets the project folder as its working directory (a subfolder of it is acceptable as
  long as it lies inside a workspace root). Fail: no usable working directory. Work that survives either outcome may
  start before the spike ends: the extension-side JSON-RPC handler (`tools/list`, `tools/call`, cancellation) and the
  framing, because a fallback with HTTP would reuse them. The bridge, discovery and Connect wait for the spike.
- **Multi-root and outside every root:** the working directory must lie inside one of the window's roots. Claude started
  outside every root gets the "no window" error that names the folder it was started in.
- **Finding `iecode.exe`:** Connect uses the extension's existing resolver (`iecode.cliPath`, else the installed CLI,
  `extension/src/cli/iecode.ts`). It runs `iecode --version` first; a missing CLI or one without the `mcp` subcommand
  gives a message pointing at "IECode: Install CLI". The `mcp` subcommand ships in the same dotnet tool and the same CI
  as the rest of the CLI.
- **Default of `iecode.ads.aiWrites` is `off`** (already so in `package.json`): connecting Claude does not by itself allow
  any write. Connect does not change the setting; its success message names the current value and the picker command.
- **One switch for all windows** (see Setup): a connected user has a pipe in every window. The pipe exposes only the
  tools, and the existing rules decide what they do (writes are `off` by default); the cost of one idle pipe per window
  is accepted. "MCP: on" in the view shows the window serves.
- **Stale files and conflicts:** the bridge probes every candidate with the handshake before it counts it. A file whose
  pipe is dead is neither a match nor a conflict. Probe results may be cached for a few seconds; the length is the
  builder's call.

## Left to the builder

- Module layout and names, in the extension (`extension/src/ads/`, `extension/src/core/`) and in the CLI.
- Exact wording of messages and dialog texts, the frame size limit and other small limits.
- If the spike shows that another Windows user can read `%LOCALAPPDATA%\iecode`, who sets the directory ACL (the CLI or
  the extension) and how.
- Whether the bridge's own answers (`initialize`, `ping`) offer one protocol revision or several, once the spike has shown
  what Claude Code sends.
