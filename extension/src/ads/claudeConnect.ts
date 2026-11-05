// "IECode: Connect Claude Code" / "Disconnect Claude Code": registers the `iecode mcp` bridge once per user with the `claude` CLI
// (user scope, stdio) and switches every window's MCP server on or off through the marker file. VS Code wiring only; the command
// lines, quoting and parsing live in core/claudeRegistration.ts.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { RegisteredEntry, addArgs, cmdLine, findOnPath, getArgs, isNotRegistered, manualCommand, parseEntry, removeArgs, restoreArgs } from '../core/claudeRegistration';
import { output, resolveIecodeExe } from '../cli/iecode';
import { aiWritesSetting } from './aiSettings';
import { AdsMcpServer, discoveryDir } from './mcpServer';

interface Claude { exe?: string; cmd?: string }
interface Ran { code: number | null; out: string }

const RUN_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

function runProcess(file: string, args: string[], verbatim = false): Promise<Ran> {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: verbatim });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (out += d.toString()));
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, out: e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** `claude.exe` is spawned directly; `claude.cmd` only through cmd.exe with one verified line (R1). */
function runClaude(claude: Claude, args: string[]): Promise<Ran> {
  if (claude.exe) return runProcess(claude.exe, args);
  return runProcess(process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${claude.cmd}" ${cmdLine(args)}"`], true);
}

/** `claude` from an absolute PATH entry, else the native and npm install locations. */
function findClaude(): Claude | undefined {
  const onPath = findOnPath(process.env.PATH ?? '', fs.existsSync);
  if (onPath.exe) return { exe: onPath.exe };
  if (onPath.cmd) return { cmd: onPath.cmd };
  const home = process.env.USERPROFILE;
  const native = home ? path.join(home, '.local', 'bin', 'claude.exe') : undefined;
  if (native && fs.existsSync(native)) return { exe: native };
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : undefined;
  if (npm && fs.existsSync(npm)) return { cmd: npm };
  return undefined;
}

const sameExe = (a: string, b: string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

/** Two windows must not change the registration at once: an exclusive lock file, stale after 60 s. */
async function withRegistrationLock<T>(dir: string, work: () => Promise<T>): Promise<T | undefined> {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'registration.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt === 0 && Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      void vscode.window.showWarningMessage('IECode: another window is changing the Claude Code registration right now. Try again in a minute.');
      return undefined;
    }
  }
  try {
    return await work();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** The discovery directory in a local Windows window; connecting makes no sense anywhere else. */
const localDir = (): string | undefined => (vscode.env.remoteName === undefined && process.platform === 'win32' ? discoveryDir() : undefined);

const LOCAL_ONLY = 'Claude Code works with a local Windows VS Code window only.';

const failed = (what: string, r: Ran): false => {
  output.error(`${what}: exit ${r.code}\n${r.out.trim()}`);
  void vscode.window.showErrorMessage(`IECode: ${what} (exit ${r.code}). ${r.out.trim().split(/\r?\n/)[0] ?? ''}`.trim());
  return false;
};

export function registerClaudeConnect(ctx: vscode.ExtensionContext, server: AdsMcpServer) {
  const connect = async () => {
    const dir = localDir();
    if (!dir) {
      void vscode.window.showErrorMessage(`IECode: Connect ${LOCAL_ONLY}`);
      return;
    }
    const exe = resolveIecodeExe();
    if (!exe) {
      void vscode.window.showWarningMessage('IECode: the iecode CLI was not found. Run "IECode: Install CLI" first.');
      return;
    }
    const help = await runProcess(exe, ['mcp', '--help']);
    if (help.code !== 0) {
      void vscode.window.showWarningMessage(`IECode: ${exe} has no "mcp" command (an older CLI?). Run "IECode: Install CLI" to update it.`);
      return;
    }
    const claude = findClaude();
    if (!claude) return offerManual(exe, server);

    const done = await withRegistrationLock(dir, async () => {
      const got = await runClaude(claude, getArgs());
      let saved: RegisteredEntry | undefined;
      if (got.code === 0) {
        saved = parseEntry(got.out);
        if (!saved) return failed('Could not read the existing "iecode" entry of Claude Code, nothing was changed', got);
      } else if (!isNotRegistered(got.out)) {
        return failed('"claude mcp get iecode" failed, nothing was changed', got);
      }
      if (saved && sameExe(saved.command, exe) && saved.args.length === 1 && saved.args[0] === 'mcp' && saved.scope === 'user') return true; // already ours
      if (saved) {
        const rm = await runClaude(claude, removeArgs());
        if (rm.code !== 0) return failed('Could not replace the existing "iecode" entry, nothing was changed', rm);
      }
      const add = await runClaude(claude, addArgs(exe));
      if (add.code === 0) return true;
      failed('"claude mcp add" failed', add);
      if (saved) {
        const back = restoreArgs(saved);
        const restored = back ? await runClaude(claude, back) : undefined;
        if (!restored || restored.code !== 0) {
          void vscode.window.showErrorMessage(`IECode: the previous "iecode" entry of Claude Code could not be restored. It was:\n${saved.raw}`, { modal: true });
        }
      }
      return false;
    });
    if (!done) return;
    await server.setConnected(true);
    void vscode.window.showInformationMessage(
      `IECode: Claude Code connected. A running Claude session needs /mcp to reconnect or a restart. AI writes are currently "${aiWritesSetting()}"; change with "IECode: Set AI Write Access…".`);
  };

  const disconnect = async () => {
    const dir = localDir();
    if (!dir) {
      void vscode.window.showErrorMessage(`IECode: Disconnect ${LOCAL_ONLY}`);
      return;
    }
    const exe = resolveIecodeExe();
    const claude = findClaude();
    let note = '';
    if (!claude) {
      note = ' The claude CLI was not found, so its entry was not touched: run "claude mcp remove -s user iecode" yourself.';
    } else {
      const manual = 'run "claude mcp remove -s user iecode" yourself if it should go.';
      const outcome = await withRegistrationLock(dir, async () => {
        const got = await runClaude(claude, getArgs());
        if (got.code !== 0) return isNotRegistered(got.out) ? '' : ` "claude mcp get iecode" failed, so its entry was not touched: ${manual}`;
        const entry = parseEntry(got.out);
        if (!entry) return ` The "iecode" entry of Claude Code could not be read, so it was not touched: ${manual}`;
        if (!exe) return ` The iecode CLI was not found, so the "iecode" entry of Claude Code could not be checked and was not touched: ${manual}`;
        if (!sameExe(entry.command, exe) || entry.args.length !== 1 || entry.args[0] !== 'mcp') return ' A different "iecode" entry of Claude Code was left alone.';
        const rm = await runClaude(claude, removeArgs());
        if (rm.code === 0) return '';
        failed('"claude mcp remove" failed', rm);
        return ` Its entry is still registered: ${manual}`;
      });
      if (outcome === undefined) return; // another window holds the lock and the user was told: nothing changed
      note = outcome;
    }
    await server.setConnected(false);
    void vscode.window.showInformationMessage(`IECode: Claude Code disconnected; no window serves the ADS tools any more.${note}`);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.mcpConnect', connect),
    vscode.commands.registerCommand('iecode.mcpDisconnect', disconnect),
  );
}

/** No `claude` found: the user can run the registration by hand; the state is then "not verified". */
async function offerManual(exe: string, server: AdsMcpServer): Promise<void> {
  const copy = await vscode.window.showWarningMessage(
    'IECode: the claude CLI was not found on PATH. Copy the registration command and run it in a terminal where claude works.', 'Copy Command');
  if (!copy) return;
  await vscode.env.clipboard.writeText(manualCommand(exe));
  const ran = await vscode.window.showInformationMessage('IECode: the command is on the clipboard. Click "I ran it" once it succeeded.', 'I ran it');
  if (!ran) return;
  await server.setConnected(true);
  void vscode.window.showInformationMessage('IECode: connected (not verified: the registration was not checked). A running Claude session needs /mcp to reconnect or a restart.');
}
