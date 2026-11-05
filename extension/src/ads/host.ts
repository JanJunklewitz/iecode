// The `iecode ads serve` host process behind the ADS watchlist, the scope and the LM tools: one process per
// window, started on use and stopped 30 s after the last use. It owns the watch list (workspaceState) and the
// sample buffer; requests and replies are JSON lines (protocol in cli/README.md, "Live values").

import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { HostMessage, PROTOCOL, PendingRequests, RequestTimeout, ScopeBuffer, WatchEntry, WatchItem, clampBufferSeconds, clampInterval, hostStartFailure, parseHostLine, parseWatchList, settingsError, watchLimitError, writeStage } from '../core/adswatch';
import { WriteNotSent, WriteOutcomeUnknown } from '../core/writeGate';
import { cliAvailable, customCliPath, output, useInstallDir } from '../cli/iecode';

const KEY = 'iecode.adsWatch';
const REQUEST_MS = 10_000;
const HELLO_MS = 10_000;
const IDLE_MS = 30_000;

export interface AdsState { connected: boolean; error?: string }
export interface AdsReadResult { symbol: string; type: string; value: string | null; error: string | null }

interface Settings { target: string; port: number; intervalMs: number; bufferSeconds: number }

function settings(): Settings {
  const c = vscode.workspace.getConfiguration('iecode.ads');
  return {
    target: c.get<string>('target', 'local').trim(),
    port: c.get<number>('port', 851),
    intervalMs: c.get<number>('sampleIntervalMs', 100),
    bufferSeconds: c.get<number>('bufferSeconds', 300),
  };
}

/** The host could not start; already shown to the user, so callers need not show it again. */
export class StartError extends Error {
  constructor(message: string, readonly action?: 'install' | 'settings', readonly setting = 'iecode.ads') { super(message); }
}

export { WriteNotSent, WriteOutcomeUnknown };

/** What `AdsHost.write` returns when the write went through; `value` is null when only the read-back failed. */
export interface HostWriteResult { value: string | null; readBackError?: string }

export class AdsHost implements vscode.Disposable {
  private static instance: AdsHost | undefined;

  static get(ctx: vscode.ExtensionContext): AdsHost {
    if (!AdsHost.instance) {
      AdsHost.instance = new AdsHost(ctx);
      ctx.subscriptions.push(AdsHost.instance);
    }
    return AdsHost.instance;
  }

  private readonly samples = new vscode.EventEmitter<void>();
  private readonly itemsChanged = new vscode.EventEmitter<void>();
  private readonly stateChanged = new vscode.EventEmitter<AdsState>();
  readonly onSamples = this.samples.event;
  /** The resolved watch items changed (types, errors, list). */
  readonly onItems = this.itemsChanged.event;
  readonly onState = this.stateChanged.event;
  readonly buffer: ScopeBuffer;

  private proc: ChildProcessWithoutNullStreams | undefined;
  /** "<target>:<port>" the running child was started with; a write must go to a child started for the confirmed target. */
  private procKey: string | undefined;
  private ready: Promise<void> | undefined;
  private pending = new PendingRequests();
  private nextId = 1;
  private gen = -1;
  private items_: WatchItem[] = [];
  private state_: AdsState = { connected: false };
  private intervalMs: number;
  private leases = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  // a failed start is not retried by itself (view visibility, scope), only by a user action or a settings change
  private failure: StartError | undefined;
  // value read back by a write, shown until the next sample brings the real one; keyed in lower case (ADS names are case-insensitive)
  private written = new Map<string, string>();
  private stopped = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly ctx: vscode.ExtensionContext) {
    const s = settings();
    this.buffer = new ScopeBuffer(clampBufferSeconds(s.bufferSeconds));
    this.intervalMs = s.intervalMs;
    this.items_ = this.watched().map(symbol => ({ symbol, type: '', numeric: false, error: null }));
    this.disposables.push(this.samples, this.itemsChanged, this.stateChanged, vscode.workspace.onDidChangeConfiguration(e => {
      const targetChanged = e.affectsConfiguration('iecode.ads.target') || e.affectsConfiguration('iecode.ads.port');
      if (targetChanged) {
        // samples and read-back values of the old target must not be shown under the new one, also while no host runs
        this.buffer.clear();
        this.written.clear();
        this.items_ = this.watched().map(symbol => ({ symbol, type: '', numeric: false, error: null }));
        this.itemsChanged.fire();
      }
      if (targetChanged || e.affectsConfiguration('iecode.cliPath')) {
        this.failure = undefined;
        if (this.proc) this.restart();
        else if (this.leases > 0) void this.ensure().catch(() => undefined);
      }
      if (e.affectsConfiguration('iecode.ads.bufferSeconds')) this.buffer.setSeconds(clampBufferSeconds(settings().bufferSeconds));
      if (e.affectsConfiguration('iecode.ads.sampleIntervalMs')) void this.setInterval(settings().intervalMs).catch(() => undefined);
    }));
  }

  /** Sample interval (ms) and buffer length (s) as configured, within the allowed bounds. */
  sampling(): { intervalMs: number; bufferSeconds: number } {
    const s = settings();
    return { intervalMs: clampInterval(s.intervalMs), bufferSeconds: clampBufferSeconds(s.bufferSeconds) };
  }

  /** "<target>:<port>" of the current settings; an approved write is bound to it. */
  targetKey(): string {
    const s = settings();
    return `${s.target}:${s.port}`;
  }

  /** The configured target as shown to the user (write confirmations). */
  target(): string {
    const s = settings();
    return s.port === 851 ? s.target : `${s.target}:${s.port}`;
  }

  state(): AdsState { return this.state_; }

  items(): WatchItem[] { return this.items_; }

  /** Last value text of a watched symbol (after a write: the value read back until the next sample). */
  value(symbol: string): string | null | undefined {
    return this.written.get(symbol.toLowerCase()) ?? this.buffer.latest(symbol)?.value;
  }

  /** Like value(), with the sample time; a value read back by a write has no time. */
  valueAt(symbol: string): { value: string | null; t?: number } | undefined {
    const w = this.written.get(symbol.toLowerCase());
    if (w !== undefined) return { value: w };
    const l = this.buffer.latest(symbol);
    return l ? { value: l.value, t: l.t } : undefined;
  }

  watched(): string[] {
    return this.entries().map(e => e.symbol);
  }

  /** The saved list with the AI flag per entry. */
  entries(): WatchEntry[] {
    return parseWatchList(this.ctx.workspaceState.get<unknown>(KEY, []));
  }

  /** Sets the list by name; symbols already watched keep their AI flag, new ones count as the user's. */
  async setWatched(symbols: string[]): Promise<WatchItem[]> {
    const flags = new Map(this.entries().map(e => [e.symbol.toLowerCase(), e.ai]));
    return this.setEntries(symbols.map(symbol => ({ symbol, ai: flags.get(symbol.trim().toLowerCase()) ?? false })));
  }

  async setEntries(entries: WatchEntry[]): Promise<WatchItem[]> {
    // ADS names are case-insensitive
    const seen = new Set<string>();
    const kept: WatchEntry[] = [];
    for (const e of entries) {
      const symbol = e.symbol.trim();
      if (!symbol || seen.has(symbol.toLowerCase())) continue;
      seen.add(symbol.toLowerCase());
      kept.push({ symbol, ai: e.ai });
    }
    const list = kept.map(e => e.symbol);
    // a list the host rejects must not be saved: it would be re-sent and fail on every start
    const tooMany = watchLimitError(list.length);
    if (tooMany) throw new Error(tooMany);
    await this.ctx.workspaceState.update(KEY, kept);
    const known = new Map(this.items_.map(i => [i.symbol, i]));
    this.items_ = list.map(symbol => known.get(symbol) ?? { symbol, type: '', numeric: false, error: null });
    this.itemsChanged.fire();
    // an empty list needs no host; a running one stops polling
    if (list.length === 0 && !this.proc) return this.items_;
    return this.leased(async () => {
      await this.ensure(true);
      this.applyItems(await this.request({ op: 'watch', symbols: list }) as { gen: number; items: WatchItem[] });
      return this.items_;
    });
  }

  async read(symbols: string[]): Promise<AdsReadResult[]> {
    return this.leased(async () => {
      await this.ensure(true);
      const rows = await this.request({ op: 'read', symbols }) as { symbol: string; type: string | null; value: string | null; error: string | null }[];
      return rows.map(r => ({ symbol: r.symbol, type: r.type ?? '', value: r.value, error: r.error }));
    });
  }

  /**
   * Writes without asking: every caller confirms first (UI: always, C0; AI tools: through the write gate).
   * `beforeSend` runs right before the request is written, with no await in between; a returned string refuses the
   * write. Failures are `WriteNotSent` (nothing was sent) or `WriteOutcomeUnknown`; a failed read-back is a result.
   */
  async write(symbol: string, value: string, beforeSend?: () => string | undefined): Promise<HostWriteResult> {
    return this.leased(async () => {
      try {
        await this.ensure(true);
      } catch (e) {
        throw new WriteNotSent((e as Error).message, e instanceof StartError);
      }
      const key = symbol.trim().toLowerCase();
      // From here to the write there is no await: the guard, the child it checks and the write see the same state.
      const child = this.proc;
      if (!child) throw new WriteNotSent('The ADS host is not running.');
      if (this.procKey !== this.targetKey()) throw new WriteNotSent('The ADS host runs for another target than the settings name; try again.');
      const refused = beforeSend?.();
      if (refused) throw new WriteNotSent(refused);
      const reply = this.send(child, { op: 'write', symbol, value });
      let data: unknown;
      try {
        data = await reply;
      } catch (e) {
        this.written.delete(key);
        const failed = writeStage({ error: e });
        if (failed.kind === 'notSent') throw new WriteNotSent(failed.reason);
        const reason = e instanceof RequestTimeout ? `Write of ${symbol} timed out` : failed.kind === 'unknown' ? failed.reason.replace(/\.$/, '') : '';
        throw new WriteOutcomeUnknown(`${reason}; the value may or may not have been written`);
      }
      const done = writeStage({ data });
      if (done.kind !== 'written') throw new WriteOutcomeUnknown(`Unexpected reply to the write of ${symbol}; the value may or may not have been written`);
      if (done.value === null) {
        this.written.delete(key);
      } else {
        this.written.set(key, done.value);
        this.itemsChanged.fire();
      }
      return { value: done.value, readBackError: done.readBackError };
    });
  }

  async setInterval(ms: number): Promise<void> {
    this.intervalMs = clampInterval(ms);
    if (this.proc && this.ready) {
      await this.ready;
      await this.request({ op: 'interval', ms: this.intervalMs });
    }
  }

  /**
   * Keeps the host running while the lease is held (view visible with a non-empty list, scope open); starts it
   * when needed. The host stops 30 s after the last lease ends (O11).
   */
  use(): vscode.Disposable {
    this.acquire();
    void this.ensure().catch(() => undefined);
    let done = false;
    return new vscode.Disposable(() => { if (!done) { done = true; this.release(); } });
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.stop('The ADS host stopped.');
    this.disposables.forEach(d => d.dispose());
    if (AdsHost.instance === this) AdsHost.instance = undefined;
  }

  // ---- lifetime ----

  private acquire() {
    this.leases++;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private release() {
    this.leases = Math.max(0, this.leases - 1);
    if (this.leases > 0 || !this.proc) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.leases === 0) this.stop('The ADS host stopped (idle).'); }, IDLE_MS);
  }

  private async leased<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try { return await fn(); } finally { this.release(); }
  }

  /** Starts the host if needed and resolves on its hello. `byUser`: retry after a failed start and show errors. */
  private ensure(byUser = false): Promise<void> {
    if (this.ready) return this.ready;
    if (this.failure && !byUser) return Promise.reject(this.failure);
    this.failure = undefined;
    const p: Promise<void> = this.start().catch((e: Error) => {
      // a host we stopped ourselves (restart, idle) is no start failure, and a newer start must stay
      if (!(e instanceof StartError) || (this.ready !== p && this.ready !== undefined)) {
        if (this.ready === p) this.ready = undefined;
        throw e;
      }
      this.ready = undefined;
      this.failure = e;
      this.setState({ connected: false, error: e.message });
      void this.report(e);
      throw e;
    });
    this.ready = p;
    return p;
  }

  private async report(e: StartError) {
    const action = e.action === 'install' ? 'Install CLI' : e.action === 'settings' ? 'Open Settings' : 'Show Output';
    const pick = await vscode.window.showErrorMessage(`IECode: ${e.message}`, action);
    if (pick === 'Install CLI') await vscode.commands.executeCommand('iecode.installCli');
    else if (pick === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', e.setting);
    else if (pick) output.show();
  }

  private start(): Promise<void> {
    if (!cliAvailable()) return Promise.reject(new StartError('Live ADS values need Windows with the iecode CLI.'));
    const s = settings();
    const bad = settingsError(s);
    if (bad) return Promise.reject(new StartError(bad, 'settings'));
    useInstallDir();
    const custom = customCliPath();
    const args = ['ads', 'serve', '-t', s.target, '--port', String(s.port)];
    output.info(`> iecode ${args.join(' ')}`);
    const started = Date.now();
    const child = spawn(custom ?? 'iecode', args, { env: { ...process.env, NO_COLOR: '1' }, windowsHide: true });
    this.proc = child;
    this.procKey = `${s.target}:${s.port}`;
    this.gen = -1;
    // writing to a host that just died must not throw in the extension host
    child.stdin.on('error', () => undefined);
    let hello = false;

    return new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => { if (!hello) { hello = true; reject(this.stopped.has(child) ? new Error('The ADS host was stopped.') : e); } };
      const helloTimer = setTimeout(() => {
        if (hostStartFailure(false, null, Date.now() - started) === 'too old') {
          fail(this.tooOld());
          child.kill();
        }
      }, HELLO_MS + 1);

      lines(child.stdout, line => {
        const msg = parseHostLine(line);
        if (!msg) { if (line.trim()) output.info(line); return; }
        if ('event' in msg && msg.event === 'hello') {
          clearTimeout(helloTimer);
          if (msg.protocol !== PROTOCOL) {
            fail(new StartError(`The iecode CLI speaks ADS host protocol ${msg.protocol}, this extension ${PROTOCOL}. Update both to the same release.`, 'install'));
            child.kill();
            return;
          }
          hello = true;
          resolve();
          void this.afterHello(child);
          return;
        }
        if (this.proc === child) this.handle(msg);
      });
      lines(child.stderr, line => { if (line.trim()) output.info(`[ads serve] ${line}`); });

      child.on('error', e => {
        clearTimeout(helloTimer);
        const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
        fail(enoent
          ? custom
            ? new StartError(`The iecode CLI set in iecode.cliPath ("${custom}") was not found. Fix or clear that setting.`, 'settings', 'iecode.cliPath')
            : new StartError('The iecode CLI was not found. Install it to see live ADS values.', 'install')
          : new StartError(`Cannot start the ADS host: ${e.message}`));
        this.exited(child, `The ADS host could not start: ${e.message}`);
      });
      child.on('close', code => {
        clearTimeout(helloTimer);
        output.info(`ADS host exited (code ${code})`);
        // an exit after hello is never "too old" (R3): a bad target arrives as a state error
        if (!hello) {
          fail(hostStartFailure(false, code, Date.now() - started) === 'too old'
            ? this.tooOld()
            : new StartError(`The ADS host exited with code ${code} before it started. See the IECode output.`));
        }
        this.exited(child, `The ADS host exited (code ${code}).`);
      });
    });
  }

  private tooOld(): StartError {
    return new StartError('The iecode CLI is too old for live ADS values (no "ads serve"). Update it with Install CLI.', 'install');
  }

  /** Sends the interval and the saved list to a fresh host (also after a restart). */
  private async afterHello(child: ChildProcessWithoutNullStreams) {
    try {
      await this.request({ op: 'interval', ms: this.intervalMs });
      const list = this.watched();
      if (list.length && this.proc === child) this.applyItems(await this.request({ op: 'watch', symbols: list }) as { gen: number; items: WatchItem[] });
    } catch (e) {
      if (this.proc === child) output.warn(`ADS host: ${(e as Error).message}`);
    }
  }

  private exited(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.proc !== child) return;
    this.proc = undefined;
    this.ready = undefined;
    this.pending.rejectAll(reason);
    this.setState({ connected: false, error: this.failure?.message ?? (this.leases > 0 ? reason : undefined) });
  }

  private stop(reason: string) {
    const child = this.proc;
    if (!child) return;
    this.stopped.add(child);
    this.proc = undefined;
    this.ready = undefined;
    this.pending.rejectAll(reason);
    this.setState({ connected: false });
    // the host answers what it has read and exits when stdin closes; kill if it hangs in an ADS call
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000).unref();
  }

  private restart() {
    this.stop('The ADS host restarted (settings changed).');
    if (this.leases > 0) void this.ensure(true).catch(() => undefined);
  }

  // ---- messages ----

  private request(body: Record<string, unknown>): Promise<unknown> {
    const child = this.proc;
    if (!child) return Promise.reject(new Error('The ADS host is not running.'));
    return this.send(child, body);
  }

  /** Writes the request to this child; synchronous, so a caller can guard and send without an await in between. */
  private send(child: ChildProcessWithoutNullStreams, body: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const reply = this.pending.add(id, REQUEST_MS);
    child.stdin.write(JSON.stringify({ id, ...body }) + '\n');
    return reply;
  }

  private handle(msg: HostMessage) {
    if (!('event' in msg)) return this.pending.settle(msg);
    switch (msg.event) {
      case 'samples':
        this.buffer.push(msg.gen, msg.rows);
        if (this.written.size) this.written.clear();
        this.samples.fire();
        break;
      case 'items':
        this.applyItems(msg);
        break;
      case 'state':
        this.setState({ connected: msg.connected, error: msg.error });
        break;
    }
  }

  private applyItems(data: { gen: number; items: WatchItem[] }) {
    // a reply to an older watch must not undo a newer one
    if (data.gen < this.gen) return;
    this.gen = data.gen;
    this.buffer.setItems(data.gen, data.items);
    this.items_ = data.items;
    this.itemsChanged.fire();
  }

  private setState(s: AdsState) {
    if (s.connected === this.state_.connected && s.error === this.state_.error) return;
    this.state_ = s;
    this.stateChanged.fire(s);
  }
}

/** Calls `fn` per complete line of a stream. */
function lines(stream: NodeJS.ReadableStream, fn: (line: string) => void) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      fn(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  });
}
