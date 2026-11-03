# ADS MCP server for Claude Code: design

Date: 2026-11-03. Status: draft for review.

## Intent

The user debugs PLC code together with an AI. The AI should be able to add variables to the ADS watch list on its own,
look at their history from the sample buffer and write variables. Copilot can already do this through the
`vscode.lm` tools in [extension/src/ads/lmTools.ts](../../../extension/src/ads/lmTools.ts). Most of the daily AI work is
done with Claude Code, which cannot call `vscode.lm` tools. This design gives Claude Code the same five tools through an
MCP server that the extension serves.

## Goals

- Claude Code gets the five ADS tools with the same behaviour as the Copilot tools: `symbols`, `watch`, `read`,
  `scope`, `write`.
- One shared state: the MCP tools work on the same `AdsHost` (watch list, sample buffer, ADS connection) as the ADS
  Watch view, the ADS Scope and the Copilot tools. A variable Claude adds shows up in the view and the scope at once.
- The same write rules: `iecode.ads.aiWrites` off / confirm / auto, read from the user settings only, and confirm
  instead of auto while the workspace settings redirect the target or port (`workspaceTarget()`).
- With `confirm`, IECode shows its own modal VS Code dialog with variable, value and target. Claude Code's own tool
  permission prompt comes on top of that; IECode does not rely on it.
- One-time setup through a command "IECode: Connect Claude Code".

## Non-goals

- No new ADS features beyond what the Copilot tools do today.
- No change to the ADS Watch view, the ADS Scope or the sample buffer, except a short status hint and the buffer fix
  on a target change (see below).
- No MCP server without VS Code: the server lives and dies with the extension host of a window.
- No support for other MCP clients than Claude Code as a goal; others may work, nobody tests them.

## Anti-goals (failure even if it works)

- A web page in a browser, another Windows user on the machine, or a blind port probe can read or write PLC
  variables through the server. Processes of the same Windows user are out of scope on purpose (decided with the
  user): they can read the token in `~/.claude.json`, and they could write the PLC over the TwinCAT router without
  IECode anyway.
- The token ends up in the repository (`.mcp.json` in the workspace) or in a log.
- Auto-approve applies to a target that a cloned repository chose.
- The Copilot tools and the MCP tools drift apart in behaviour because the logic is duplicated.

## Constraints

- The extension has no runtime dependencies: it is compiled with plain `tsc` and packaged with
  `vsce package --no-dependencies`. Adding a dependency means adding a bundler or changing the packaging.
- The repository is public: no internal names, links or data in code, tests, docs or commits.
- `AdsHost` is per window; the watch list is per workspace (`workspaceState`). Several VS Code windows can be open at
  the same time, each with its own host and watch list.
- MCP spec: the current revision is 2026-07-28 (stateless, no `initialize`, no `Mcp-Session-Id`, `Mcp-Method` /
  `Mcp-Name` headers). Which revision the installed Claude Code speaks is not verified yet.
- MCP spec: the server must answer 403 to a request with an `Origin` header it does not accept (DNS rebinding).
- Claude Code shows MCP elicitation dialogs only in interactive terminal sessions, so they are no way to confirm a write
  in the VS Code extension of Claude Code.
- Known Claude Code issue (anthropics/claude-code#46640): its VS Code extension probes for OAuth on HTTP servers without
  authentication and fails. A static bearer token header avoids that path; to be verified.

## Decided with the user

- MCP, not a CLI plus skill. Reason: the state (watch list, buffer, connection) lives in the running extension; a CLI
  would need to talk to the extension anyway. With MCP tool search the token cost of five tools is negligible, and MCP
  gives per-tool permissions in Claude Code (`mcp__iecode__ads_write` apart from the read tools).
- Transport: HTTP on `127.0.0.1` only, with a token.
- Registration in the user's Claude Code configuration (`~/.claude.json`), never in a `.mcp.json` in the workspace.
- A separate IECode confirmation dialog in VS Code for writes with `confirm`.
- Sampling stays demand-driven: a connected Claude does not keep the host running; Claude gets a note about gaps.
- Processes of the same Windows user are outside the threat model.

## Design

### Server

- Served by the extension host over `node:http`, bound to `127.0.0.1`, path `/mcp`.
- Speaks MCP JSON-RPC over Streamable HTTP with plain JSON responses (no SSE stream needed: no tool call reports
  progress, the server sends no notifications).
- Supported methods: `initialize` and `notifications/initialized` (older revisions), `server/discover` (2026-07-28),
  `ping`, `tools/list`, `tools/call`, plus the notification `notifications/cancelled` (see Writes). Other requests get
  JSON-RPC "method not found"; notifications never get a JSON-RPC response (HTTP 202, empty body). The server keeps no
  session; a `Mcp-Session-Id` header is ignored, none is issued. The exact set of revisions, HTTP methods (GET without
  SSE support: 405), `Accept` / `Content-Type` handling and version negotiation are fixed after the spike, from the
  authoritative spec text, as a transport checklist in the plan.
- Only a local Windows topology is supported: the extension host runs on the same Windows machine as Claude Code. In a
  remote, WSL or container extension host, Connect refuses with a message.
- Every request must carry `Authorization: Bearer <token>`; otherwise 401 without details. A request with an `Origin`
  header gets 403 (no browser origin is legitimate for this server). The `Host` header must be `127.0.0.1:<port>` or
  `localhost:<port>`; otherwise 403.
- Request body limit (for example 1 MB); larger bodies get 413.
- Tool arguments are untrusted runtime data: they are validated (types, string lengths, array lengths, scope duration)
  before the shared tool functions see them; invalid input is a tool error, not a crash. Output size is bounded too.

### Tools

- MCP tool names: `ads_symbols`, `ads_watch`, `ads_read`, `ads_scope`, `ads_write` on the server `iecode`, so Claude
  Code shows them as `mcp__iecode__ads_*`.
- Descriptions and input schemas come from the `languageModelTools` entries in `extension/package.json`
  (`modelDescription`, `inputSchema`), read at runtime from `ctx.extension.packageJSON`. One source for both clients.
  The descriptions mention the Copilot names `adsWatch` / `adsScope` in places, and the write description explains
  the Copilot approval ("Always Allow"); the builder rewrites them so the shared text is true for both clients and
  keeps client-specific approval details out of it. The `iecode.ads.aiWrites` setting and picker texts are updated to
  cover both clients.
- The tool logic of `lmTools.ts` moves into functions that take the input and return the result text (and an error
  flag). The Copilot tools and the MCP tools both call these functions; only the approval presentation differs per
  client, the final authorization check (see Writes) is shared. Tools that talk to the host take a lease
  (`host.use()`) as today.
- Sampling stays demand-driven (decided with the user): a connected Claude does not keep the host running. The host
  samples while the ADS Watch view or the scope is open, or while a tool call holds a lease, and stops 30 s after the
  last use. When the scope or read results have gaps or old samples, Claude gets a clear note, for example "no samples
  since hh:mm:ss: sampling only runs while the ADS Watch view or the ADS Scope is open". Read results include the age
  of a buffered value.
- Results are MCP `content: [{ type: "text", text }]`; a failed call sets `isError: true`.

### Writes

- `off`: refused with the same text as the Copilot tool.
- `confirm`, or `auto` while `workspaceTarget()` is true: IECode shows a modal
  `vscode.window.showWarningMessage` with "Write `<symbol>` := `<value>` on `<target>`?" and the buttons "Write" and
  "Cancel" (plus the note about the workspace settings when auto is overridden). Cancel or closing the dialog returns
  "Not written: the user declined." to Claude.
- `auto` without redirect: writes without a dialog.
- The decision is taken right before the write, so the separate prepare/invoke check of the Copilot tool
  (`writeStillApproved`) is not needed for MCP. Every write is logged in the IECode output like the Copilot writes, marked
  as coming from MCP.
- A dialog that stays open must not block read tools. Writes are executed one after the other in a bounded queue;
  each queued write is checked again right before it is sent.
- Approval is bound to the operation: symbol, value, ADS target and port as shown in the dialog. Right before the
  value is sent to the host (after any host start), IECode checks again that the write rules still allow it and that
  target and port are unchanged; otherwise it does not write and tells Claude why. This check sits in the shared write
  path, so it protects the Copilot tool too. It does not prove which physical machine is behind an AMS route.
- Cancellation and the dispatch boundary: until a write is sent to the host, a cancelled request guarantees no write.
  Cancelled means: a `notifications/cancelled` for the request, the HTTP response closed before it was sent, server
  shutdown, or an approval deadline (for example 2 min) passing. A later click on "Write" then writes nothing; IECode
  logs it and shows "Not written: the request was cancelled." Once the value is sent, cancellation cannot take it back.
- Three outcomes are told apart: not sent (with the reason), written (with the value read back, which the PLC may
  already have changed again), and outcome unknown (timeout or host exit after sending). The unknown text tells Claude
  not to retry on its own but to read the variable and ask the user.

### Setup and discovery

- No global setting. Each workspace stores whether it is connected (`workspaceState`). The server of a window only runs
  while its workspace is connected; a window of a workspace that was never connected opens no port. (My call.)
- Command "IECode: Connect Claude Code":
  1. marks the workspace as connected and starts the server,
  2. registers the server for the current workspace folder in Claude Code with
     `claude mcp add --transport http --scope local iecode http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`,
     run with the workspace folder as working directory (local scope: private to the user, per project, stored in
     `~/.claude.json`),
  3. if the `claude` executable is not found, offers to copy that command to the clipboard (with a note that it
     contains the token) instead of copying it silently.
  - `claude` is started with an argument array, never through a shell string. Its output and errors are shown with the
    token redacted.
  - Connect is transactional: the workspace counts as connected only after the registration succeeded. An existing
    `iecode` entry is replaced only once the new one can be written; on failure the previous state is kept and the
    exit code and (redacted) output are reported. After a new registration the user is told that a running Claude
    session needs `/mcp` reconnect or a restart.
- Command "IECode: Disconnect Claude Code": removes the registration of this workspace, stops its server and clears
  its connected flag. Other workspaces are not touched.
- Port: the first start binds port 0 and stores the port it got per workspace (`workspaceState`), so the registration
  stays valid across restarts. If the stored port is taken at start, the server binds port 0 again and re-registers
  itself the same way (only if the user connected this workspace before).
- Token: random 32 bytes per workspace, kept in `SecretStorage`, never logged, created on first connect, compared in
  constant time. Disconnect deletes it; the next Connect creates a new one.
- One owner per workspace folder: if another VS Code window already serves the same folder (the stored port answers
  with this workspace's token), Connect in the second window refuses with a message. Disconnect removes the
  registration only if it still points to this window's port.
- Multi-root workspace: registered for each workspace folder, all pointing to the one server of the window (one host,
  one watch list per window).
- Status: the ADS Watch view description shows "MCP: on" next to "AI writes: …" while the server listens (it says
  listening, not that Claude is connected). The write dialog names the workspace and the target so that several open
  windows can be told apart.

### Related fix: buffer and target change

Today the sample buffer and the last written values survive a change of `iecode.ads.target` or `.port`, so values
sampled on the old target can be shown as values of the new one (Copilot tools and views alike). Changing the target
or port clears the buffer and the written-value cache. This is a small separate change, planned as its own task.

### Errors

- The server could not start (port, permissions): one warning with the reason, the Copilot tools keep working.
- Tool errors (host does not start, PLC unreachable) come back as tool results with `isError: true`, same text as for
  Copilot.

## First step: go/no-go spike

Before the plan is built out, a throwaway spike (about 30 minutes) checks against the installed Claude Code, in the
VS Code extension and in the terminal:

- a minimal `node:http` server with a bearer token header connects (`/mcp` shows it connected, no OAuth probe failure),
- which protocol revision and which methods Claude Code sends,
- how Claude Code reacts to a long tool call (timeout, what interrupting sends).

If the spike passes, the design above stands. If it fails, the fallback is decided with the user then; the candidates
are a stdio bridge script started by Claude Code that relays to the extension, the official MCP SDK with a bundler, or
supporting the terminal Claude Code only.

## Testing

- Unit tests for the protocol layer (no VS Code): `initialize`, `tools/list`, `tools/call`, unknown method, missing or
  wrong token (401), `Origin` present (403), wrong `Host` (403), oversized body (413).
- Notifications get no JSON-RPC response; malformed envelopes and invalid tool arguments give errors, no crash.
- Unit tests for the shared tool functions where the Copilot tests do not cover them yet.
- Write path, deterministic with a fake host: target or port changed during the dialog or during host start, cancel
  before sending (each cancellation kind), cancel after sending, outcome unknown, approval deadline, queue order,
  dialog still open when the extension is disposed.
- Buffer cleared on target or port change.
- Connect: registration fails, `claude` missing, second window for the same folder, Disconnect after another window
  took over.
- Manual F5 check with Claude Code in the VS Code extension and in the terminal: connect, `/mcp` shows `iecode`
  connected, watch a variable and see it in the view and scope, scope summary, write with off / confirm / auto, cancel
  in the dialog, interrupt Claude while the dialog is open, close the ADS Watch view and ask for the scope (gap note),
  restart VS Code and reconnect without new setup. Record the Claude Code versions. Repeat the main checks with the
  packaged VSIX, not only in the F5 session.

## Left to the builder

- Hand-written protocol layer or the official MCP TypeScript SDK, decided after the spike and the transport
  checklist. The SDK means a bundler or a change to the `--no-dependencies` packaging; the hand-written layer is
  feasible but not trivial (lifecycle, notifications, cancellation, version handling).
- Module layout and names inside `extension/src/ads/`.
- Exact wording of messages and dialog texts.
- The request body limit and other small limits.
