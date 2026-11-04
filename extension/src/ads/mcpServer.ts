// Serves the ADS tools of this window to Claude Code through a named pipe: a discovery file tells the `iecode mcp` bridge
// which window serves which folder, the handshake secret keeps other users and browsers out. VS Code wiring only; the
// protocol, pipe, discovery and lifecycle logic live in core/ and are unit-tested there.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WorkspaceState } from '../state';
import { MCP_NAMES } from '../core/adsToolText';
import { WriteGate } from '../core/writeGate';
import { McpSession } from '../core/mcp';
import { buildMcpTools, descriptorsFromManifest } from '../core/mcpTools';
import { InstanceFile, canonicalRoot, toolsFile } from '../core/mcpWire';
import { PipeConnection, PipeServer, pipeExists, servePipe } from '../core/mcpPipe';
import { FsOps, aclAllowsOthers, connectedMarker, removeInstance, setConnectedMarker, sweepStaleInstances, writeInstance } from '../core/instanceFiles';
import { LifecycleQueue } from '../core/lifecycleQueue';
import { output } from '../cli/iecode';
import { adsTools } from './adsTools';

const POLL_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const STALE_MS = 600_000;

const realFs: FsOps = {
  mkdir: p => { fs.mkdirSync(p, { recursive: true }); },
  write: (p, text) => fs.writeFileSync(p, text, 'utf8'),
  rename: (a, b) => fs.renameSync(a, b),
  list: dir => fs.readdirSync(dir),
  read: p => fs.readFileSync(p, 'utf8'),
  remove: p => fs.rmSync(p, { force: true }),
  exists: p => fs.existsSync(p),
  mtimeMs: p => fs.statSync(p).mtimeMs,
};

/** `%LOCALAPPDATA%\iecode\mcp\v1`, or undefined where there is no such place. */
function discoveryDir(): string | undefined {
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, 'iecode', 'mcp', 'v1') : undefined;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))));

/** icacls from System32, not from whatever the search path finds first. */
const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');

interface Live {
  id: string;
  server: PipeServer;
  file: InstanceFile;
  connections: Set<PipeConnection>;
}

export class AdsMcpServer implements vscode.Disposable {
  private readonly queue = new LifecycleQueue();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onState = this.changed.event;
  private live: Live | undefined;
  private warned = false;
  private aclWarned = false;
  private poll: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly state: WorkspaceState, private readonly gate: WriteGate) {}

  /** Only a local Windows extension host can reach a named pipe the bridge opens. */
  private eligible(): boolean {
    return vscode.env.remoteName === undefined && process.platform === 'win32' && discoveryDir() !== undefined;
  }

  serving(): boolean { return this.live !== undefined; }

  /** The user-level "serve every window" switch: a marker file all windows poll (globalState is a per-host snapshot). */
  connected(): boolean {
    const dir = discoveryDir();
    return dir !== undefined && connectedMarker(dir, realFs);
  }

  async setConnected(on: boolean): Promise<void> {
    const dir = discoveryDir();
    if (!dir) return;
    setConnectedMarker(dir, on, realFs);
    await this.reconcile();
  }

  /** Starts the marker poll and the folder handler; serving follows the marker. */
  init(): void {
    if (!this.eligible() || this.poll) return;
    this.poll = setInterval(() => { void this.reconcile(); }, POLL_MS);
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.queue.enqueue(async () => this.republish()).catch(() => undefined); }));
    void this.reconcile();
  }

  start(): Promise<void> {
    if (!this.eligible() || !this.connected()) return Promise.resolve();
    const gen = this.queue.current();
    return this.queue.enqueue(() => this.doStart(gen)).catch(e => this.fail(e));
  }

  stop(): Promise<void> {
    this.queue.invalidate();
    return this.queue.enqueue(() => this.teardown()).catch(e => output.warn(`MCP server stop failed: ${(e as Error).message}`));
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const s of this.subscriptions) s.dispose();
    void this.stop();
    this.changed.dispose();
  }

  private async reconcile(): Promise<void> {
    const want = this.eligible() && this.connected();
    if (want && !this.live) await this.start();
    else if (!want && this.live) await this.stop();
  }

  private fail(e: unknown): void {
    const reason = (e as Error).message;
    output.warn(`MCP server could not start: ${reason}`);
    if (!this.warned) {
      this.warned = true;
      void vscode.window.showWarningMessage(`IECode: the MCP server for Claude Code could not start: ${reason}`);
    }
  }

  /** Makes sure only this user can read the discovery directory, since it holds the handshake secrets. */
  private async ensurePrivate(dir: string): Promise<boolean> {
    realFs.mkdir(dir);
    if (!aclAllowsOthers(await run(icacls, [dir]))) return true;
    const user = process.env.USERNAME;
    if (user) {
      try { await run(icacls, [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]); } catch { /* checked again below */ }
    }
    if (!aclAllowsOthers(await run(icacls, [dir]))) return true;
    if (!this.aclWarned) {
      this.aclWarned = true;
      void vscode.window.showWarningMessage(`IECode: the discovery folder ${dir} is readable by other users, so the MCP server stays off.`);
    }
    return false;
  }

  private roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
      .map(f => canonicalRoot(f.uri.fsPath, p => fs.realpathSync.native(p)));
  }

  private descriptors() {
    return descriptorsFromManifest(this.ctx.extension.packageJSON);
  }

  private session(): McpSession {
    const host = adsTools(this.ctx, this.state, MCP_NAMES);
    return new McpSession(buildMcpTools({ descriptors: this.descriptors(), tools: host, gate: this.gate, targetKey: () => host.host.targetKey() }));
  }

  private attach(conn: PipeConnection): void {
    const session = this.session();
    this.live?.connections.add(conn);
    conn.onLine(line => {
      void session.handle(line).then(reply => {
        if (reply === undefined) return;
        try { conn.send(reply); } catch (e) { output.warn(`MCP reply dropped: ${(e as Error).message}`); }
      });
    });
    conn.onClose(() => { session.close(); this.live?.connections.delete(conn); });
  }

  private async doStart(gen: { stale(): boolean }): Promise<void> {
    const dir = discoveryDir();
    if (this.live || !dir) return;
    if (!(await this.ensurePrivate(dir)) || gen.stale()) return;
    const instances = path.join(dir, 'instances');
    realFs.mkdir(instances);
    await sweepStaleInstances(instances, realFs, Date.now(), STALE_MS, async pipePath => pipeExists(pipePath));
    if (gen.stale()) return;

    const tools = this.descriptors();
    const toolsPath = path.join(dir, 'tools.json');
    realFs.write(`${toolsPath}.tmp`, toolsFile(tools));
    realFs.rename(`${toolsPath}.tmp`, toolsPath);

    const id = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('base64');
    const pipe = `iecode-mcp-${id}`;
    const connections = new Set<PipeConnection>();
    const server = await servePipe(`\\\\.\\pipe\\${pipe}`, secret, conn => this.attach(conn));
    // stop() or a removed marker while the pipe was opening: close what was opened and publish nothing
    if (gen.stale() || !this.connected()) {
      await server.close();
      return;
    }
    const file: InstanceFile = {
      format: 1, id, pid: process.pid, startedAt: new Date().toISOString(), extensionVersion: String(this.ctx.extension.packageJSON.version),
      bridgeProtocol: { min: 1, max: 1 }, pipe, roots: this.roots(), workspaceName: vscode.workspace.name ?? '', rootsRevision: 1, secret,
    };
    this.live = { id, server, file, connections };
    writeInstance(instances, file, realFs);
    this.queue.every(HEARTBEAT_MS, () => this.republish(false));
    output.info(`MCP server for Claude Code serves ${file.roots.join(', ') || 'no folder'} on ${pipe}`);
    this.changed.fire();
  }

  /** The heartbeat (same revision, fresh mtime) and the workspace-folder handler (next revision). */
  private republish(bump = true): void {
    const dir = discoveryDir();
    if (!this.live || !dir) return;
    this.live.file = { ...this.live.file, roots: this.roots(), rootsRevision: this.live.file.rootsRevision + (bump ? 1 : 0) };
    writeInstance(path.join(dir, 'instances'), this.live.file, realFs);
  }

  private async teardown(): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    const dir = discoveryDir();
    if (dir) removeInstance(path.join(dir, 'instances'), live.id, realFs);
    for (const c of live.connections) c.close();
    await live.server.close();
    this.changed.fire();
  }
}
