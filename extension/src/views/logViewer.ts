// Read-only viewer for log files: a virtual-scrolled table on top of LogSession (src/core/logsession.ts).
// A readonly custom editor with its own document, because VS Code does not hand 100 MB files to a text editor.
// The document owns the session; the panel owns only its subscriptions (one panel per document).
// The merged view (several files on one timeline) is a plain webview panel that owns its session itself.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { randomBytes } from 'crypto';
import { LogFormatDef, parseFilterTimeInput } from '../core/logformat';
import { LogSession, SessionFilters, StaleError } from '../core/logsession';
import { ViewOptions } from '../core/logview';

export const LOG_VIEW_TYPE = 'iecode.logViewer';
/** The merged view has no single document, so it is a webview panel of its own type. */
export const MERGED_VIEW_TYPE = 'iecode.logViewer.merged';

/**
 * Webview -> host. In `filters`, the time bounds come as the raw input text (fromText / toText; '' = open end); the
 * host parses them and answers each one with {type: 'filterError', field: 'from' | 'to', message} ('' = valid), and
 * an invalid bound leaves the applied one unchanged. `files: null` shows every file again (the message is JSON, which
 * drops an undefined member).
 */
type Msg =
  | { type: 'ready' }
  // find: entries (selection, detail) whose rows the reply names in `found`, also when they are later group members.
  | { type: 'rows'; rev: number; pos: number; count: number; id: number; find?: number[] }
  | ({ type: 'filters'; fromText?: string; toText?: string; files?: number[] | null } &
    Partial<Omit<SessionFilters, 'from' | 'to' | 'files'>>)
  | ({ type: 'options' } & Partial<ViewOptions>)
  | { type: 'detail'; rev: number; pos: number }
  | { type: 'jump'; rev: number; from: number; dir: 1 | -1; what: 'error' | 'bookmark'; generation: number; index?: number }
  | { type: 'bookmark'; rev: number; pos: number; generation: number; index?: number }
  | { type: 'live'; on: boolean }
  | { type: 'export' }
  | { type: 'openRaw' };

/** Most rows one request may ask for (the webview asks for windows of about 200). */
const MAX_ROWS_PER_REQUEST = 1000;
/** Least time between two state messages while the file is scanned. */
const PROGRESS_INTERVAL_MS = 100;
/** Above this total size the merge asks before it reads the files. */
const MERGE_CONFIRM_BYTES = 500 * 1024 * 1024;
/** Most workspace files the command palette offers. */
const MAX_PICK_FILES = 5000;
const LOG_FILE = /\.log$/i;
/** A file changed within this time opens live. */
const LIVE_RECENT_MS = 60 * 1000;
/** Poll interval while live, as a fallback for a file system watcher that misses changes. */
const LIVE_POLL_MS = 2000;

function userFormats(): LogFormatDef[] {
  const v = vscode.workspace.getConfiguration('iecode.logViewer').get<unknown>('formats');
  if (!Array.isArray(v)) return [];
  return v.filter((f): f is LogFormatDef =>
    !!f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.entry === 'string');
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function viewOptions(): ViewOptions {
  const c = vscode.workspace.getConfiguration('iecode.logViewer');
  const gapSeconds = c.get<number>('gapSeconds', 5);
  return { groupRepeats: c.get<boolean>('groupRepeats', false), gapMs: Math.max(0, Number(gapSeconds) || 0) * 1000 };
}

/**
 * Owns the session behind one log viewer webview: the custom editor's document or the merged panel. A single-file
 * session can be live: then the host watches the file (watcher plus poll) and feeds the changes to session.refresh().
 * Merged sessions stay static.
 */
class LogSessionHost {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the session state changed (load progress, load end, filters, options, bookmarks, live tail). */
  readonly onDidChangeState = this.changed.event;
  readonly session?: LogSession;
  /** Set when nothing can be shown at all (scheme, load failure). */
  failure?: string;
  private watch?: vscode.Disposable;
  private disposed = false;
  /** The user switched Live on or off; the mtime default after the load is skipped then. */
  private liveChosen = false;

  /** Without paths, `failure` says why nothing is shown; `label` names the content in a load failure. */
  constructor(private readonly paths: string[] | undefined, private readonly label: string, failure?: string) {
    if (!paths) {
      this.failure = failure;
      return;
    }
    this.session = LogSession.open(paths, userFormats(), viewOptions());
    void this.load(this.session);
  }

  private async load(session: LogSession) {
    let last = 0;
    try {
      await session.load(() => {
        const now = Date.now();
        if (now - last < PROGRESS_INTERVAL_MS) return;
        last = now;
        this.changed.fire();
      });
    } catch (e) {
      this.failure = `Cannot show ${this.label}: ${(e as Error).message}`;
    }
    if (this.disposed) return;
    this.changed.fire();
    if (this.failure !== undefined || this.paths?.length !== 1) return;
    if (this.liveChosen) {
      // The user's choice during the load stands; its refresh then found nothing loaded yet.
      if (session.state().live) void this.refresh();
      return;
    }
    // Live by default only for a file that is still being written.
    try {
      const { mtimeMs } = await fsp.stat(this.paths[0]);
      if (!this.liveChosen && Date.now() - mtimeMs < LIVE_RECENT_MS) this.setLive(true, false);
    } catch {
      // Gone since the load; stays static.
    }
  }

  notify() {
    if (!this.disposed) this.changed.fire();
  }

  /**
   * Live (ingest new entries) on or off; single-file sessions only. Turning it on looks at the file at once. Once the
   * user chose (byUser), the default after the load no longer applies.
   */
  setLive(on: boolean, byUser = true) {
    const s = this.session;
    if (!s || this.disposed || this.failure !== undefined || this.paths?.length !== 1) return;
    if (byUser) this.liveChosen = true;
    s.setLive(on);
    this.watch?.dispose();
    this.watch = undefined;
    if (on) {
      const file = this.paths[0];
      const name = path.basename(file);
      // A name with glob characters ('Plc[1].log') would be read as a pattern: watch the folder and filter instead.
      const glob = /[*?[\]{}!]/.test(name);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), glob ? '*' : name));
      const refresh = () => void this.refresh();
      const onEvent = (uri: vscode.Uri) => {
        if (!glob || samePath(uri.fsPath, file)) refresh();
      };
      // The watcher misses changes on some file systems (network shares); the poll catches those.
      const poll = setInterval(refresh, LIVE_POLL_MS);
      this.watch = vscode.Disposable.from(
        watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent),
        new vscode.Disposable(() => clearInterval(poll)),
      );
      refresh();
    }
    this.notify();
  }

  /** session.refresh() coalesces the calls of watcher and poll. */
  private async refresh() {
    if (await this.session?.refresh()) this.notify();
  }

  dispose() {
    this.disposed = true;
    this.watch?.dispose();
    this.watch = undefined;
    this.changed.dispose();
    // Nothing waits for the close; a failing one must not become an unhandled rejection.
    this.session?.dispose().catch(() => undefined);
  }
}

class LogDocument extends LogSessionHost implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {
    super(
      uri.scheme === 'file' ? [uri.fsPath] : undefined,
      path.basename(uri.fsPath),
      `The log viewer reads local files only; ${uri.scheme}: resources are not supported. Open the file as text instead.`,
    );
  }
}

/** Open log viewer panels (custom editors and the merged view); the key commands go to the active one. */
const panels = new Set<vscode.WebviewPanel>();

/** Registers a log viewer panel for the key commands until the returned disposable is disposed. */
export function trackLogPanel(panel: vscode.WebviewPanel): vscode.Disposable {
  panels.add(panel);
  return new vscode.Disposable(() => panels.delete(panel));
}

/** Key commands; each one posts {type: 'command', command} to the active log viewer webview. */
const PANEL_COMMANDS = ['nextError', 'previousError', 'toggleBookmark', 'nextBookmark', 'previousBookmark'] as const;

/**
 * Save dialog (default `<first file>.filtered.log` next to the first input), then the export with a cancellable
 * progress notification; the result is reported with an information or error message.
 */
async function exportFiltered(session: LogSession): Promise<void> {
  const first = session.state().files[0];
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${first}.filtered.log`),
    filters: { 'Log files': ['log'], 'All files': ['*'] },
    title: 'Export the filtered entries',
  });
  if (!target) return;
  if (target.scheme !== 'file') {
    void vscode.window.showErrorMessage('The log viewer exports to local files only.');
    return;
  }
  const ac = new AbortController();
  try {
    const n = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting the filtered log entries', cancellable: true },
      (_progress, token) => {
        token.onCancellationRequested(() => ac.abort());
        return session.exportTo(target.fsPath, ac.signal);
      });
    void vscode.window.showInformationMessage(`Exported ${n.toLocaleString('en-US')} entries to ${path.basename(target.fsPath)}.`);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    void vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
  }
}

/**
 * Puts the log viewer webview into a panel and answers its messages from `doc`'s session until the panel closes.
 * `openRaw` serves the "Open as text" button.
 */
function showLogWebview(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, doc: LogSessionHost, openRaw: () => unknown): void {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
  const nonce = randomBytes(16).toString('hex');
  const res = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
  const csp = panel.webview.cspSource;
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${res('logViewer.css')}"></head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${res('logScroll.js')}"></script>
<script nonce="${nonce}" src="${res('logDisplay.js')}"></script>
<script nonce="${nonce}" src="${res('logViewer.js')}"></script></body></html>`;

  let closed = false;
  // Replies of reads still in flight when the panel closes are dropped.
  const post = (m: unknown) => (closed ? undefined : panel.webview.postMessage(m));
  const sendState = () => {
    if (doc.failure !== undefined) return post({ type: 'error', message: doc.failure, fatal: true });
    if (doc.session) return post({ type: 'state', state: doc.session.state() });
  };
  /** A request for an older revision gets {stale} and the current state, so the webview re-requests. */
  const fail = (e: unknown, rev?: number) => {
    if (e instanceof StaleError) {
      post({ type: 'stale', rev: rev ?? e.revision });
      return sendState();
    }
    return post({ type: 'error', message: (e as Error).message });
  };

  const subs = [
    doc.onDidChangeState(() => void sendState()),
    panel.webview.onDidReceiveMessage(async (m: Msg) => {
      if (m.type === 'openRaw') {
        // Also after a fatal error, when the webview has no state to show a message in: report it as a notification.
        return Promise.resolve().then(openRaw).catch(e =>
          void vscode.window.showErrorMessage(`Cannot open as text: ${(e as Error).message}`));
      }
      if (m.type === 'ready') return sendState();
      const s = doc.session;
      if (!s || doc.failure !== undefined) return;
      try {
        switch (m.type) {
          case 'rows': {
            // Taken before the read's first await, from the same snapshot as the rows.
            const find = Array.isArray(m.find) ? m.find.slice(0, 2) : [];
            const found = s.findRows(m.rev, find);
            const rows = await s.rows(m.rev, m.pos, Math.max(0, Math.min(m.count, MAX_ROWS_PER_REQUEST)));
            return post({ type: 'rows', rev: m.rev, id: m.id, pos: m.pos, rows, find, found });
          }
          case 'filters': {
            const { type: _type, fromText, toText, files, ...rest } = m;
            const f: Partial<SessionFilters> = rest;
            if (files !== undefined) f.files = Array.isArray(files) ? files : undefined;
            for (const [field, text] of [['from', fromText], ['to', toText]] as const) {
              if (text === undefined) continue;
              const t = parseFilterTimeInput(text, field === 'to');
              post({ type: 'filterError', field, message: t.error ?? '' });
              // An own undefined member opens the bound (setFilters spreads the patch over the filters).
              if (t.error === undefined) f[field] = t.ms;
            }
            if (Object.keys(f).length === 0) return;
            // Level, time and source changes publish before the first await; a text search publishes later, and a
            // failing search only sets state.error. The state goes out after each step that changed it.
            const before = s.state().revision;
            const done = s.setFilters(f);
            const published = s.state().revision;
            if (published !== before) doc.notify();
            const error = s.state().error;
            await done;
            const after = s.state();
            if (after.revision !== published || after.error !== error) doc.notify();
            return;
          }
          case 'options': {
            const { type: _type, ...o } = m;
            s.setOptions(o);
            return doc.notify();
          }
          case 'detail': {
            const d = await s.detail(m.rev, m.pos);
            return post({ type: 'detail', rev: m.rev, pos: m.pos, text: d.text, truncated: d.truncated });
          }
          // Both name the selected entry too (index), so a live-tail commit in between does not lose them. The jump
          // answers with the current revision (the state message of a newer one went out before this reply) and the
          // target's entry, so the selection survives the next live commit before the target's rows arrive.
          case 'jump': {
            const pos = s.jump(m.rev, m.from, m.dir, m.what, { generation: m.generation, index: m.index ?? undefined });
            return post({ type: 'jumped', rev: s.currentRevision, pos, index: pos < 0 ? undefined : s.rowIndex(pos) });
          }
          case 'bookmark':
            // The revision stays; the state message makes the webview fetch the rows' bookmark flags again.
            s.toggleBookmark(m.rev, m.pos, typeof m.index === 'number' ? { generation: m.generation, index: m.index } : undefined);
            return doc.notify();
          case 'live':
            return doc.setLive(m.on);
          case 'export':
            return void (await exportFiltered(s));
        }
      } catch (e) {
        return fail(e, 'rev' in m ? m.rev : undefined);
      }
    }),
  ];
  subs.push(trackLogPanel(panel));
  panel.onDidDispose(() => {
    closed = true;
    subs.forEach(d => d.dispose());
  });
}

class LogViewerProvider implements vscode.CustomReadonlyEditorProvider<LogDocument> {
  constructor(private ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): LogDocument {
    return new LogDocument(uri);
  }

  resolveCustomEditor(doc: LogDocument, panel: vscode.WebviewPanel): void {
    showLogWebview(this.ctx.extensionUri, panel, doc, () => vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default'));
  }
}

/** The file to open: the explorer / editor title argument, else the active editor's or tab's file. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

function openAsText(uris: vscode.Uri[]) {
  for (const uri of uris) void vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: false });
}

/** Explorer selection: the selected .log files and the .log files directly inside selected folders, without repeats. */
async function explorerLogFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const out = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    const st = await vscode.workspace.fs.stat(uri);
    if (st.type & vscode.FileType.Directory) {
      const names = (await vscode.workspace.fs.readDirectory(uri))
        .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && LOG_FILE.test(name))
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const u = vscode.Uri.joinPath(uri, name);
        out.set(u.toString(), u);
      }
    } else if (LOG_FILE.test(uri.path)) {
      out.set(uri.toString(), uri);
    }
  }
  return [...out.values()];
}

/** Command palette: a multi-select pick of the workspace's .log files; undefined when cancelled or none exist. */
async function pickLogFiles(): Promise<vscode.Uri[] | undefined> {
  const found = await vscode.workspace.findFiles('**/*.log', '**/node_modules/**', MAX_PICK_FILES);
  if (found.length === 0) {
    void vscode.window.showInformationMessage('No .log files found in the workspace.');
    return undefined;
  }
  const items = found
    .map(uri => ({ label: path.basename(uri.fsPath), description: vscode.workspace.asRelativePath(uri), uri }))
    .sort((a, b) => a.description.localeCompare(b.description));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true, matchOnDescription: true, placeHolder: 'Select the log files to merge on one timeline',
  });
  return picked && picked.length > 0 ? picked.map(p => p.uri) : undefined;
}

/**
 * Opens several log files in one panel, merged by time. From the explorer: the selection (files and folders); from the
 * command palette: a pick of workspace files. One file opens in the regular log viewer.
 */
async function openMerged(ctx: vscode.ExtensionContext, arg?: unknown, selection?: unknown): Promise<void> {
  const selected = Array.isArray(selection) ? selection.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
  let uris = selected.length > 0 ? selected : arg instanceof vscode.Uri ? [arg] : await pickLogFiles();
  if (!uris) return;
  const foreign = uris.filter(u => u.scheme !== 'file');
  if (foreign.length > 0) {
    const choice = await vscode.window.showErrorMessage(
      `The log viewer reads local files only; ${foreign[0].scheme}: resources are not supported.`, 'Open as text');
    if (choice === 'Open as text') openAsText(foreign.filter(u => LOG_FILE.test(u.path)));
    return;
  }

  let total = 0;
  try {
    uris = await explorerLogFiles(uris);
    for (const u of uris) total += (await vscode.workspace.fs.stat(u)).size;
  } catch (e) {
    void vscode.window.showErrorMessage(`Cannot read the selected files: ${(e as Error).message}`);
    return;
  }
  if (uris.length === 0) {
    void vscode.window.showInformationMessage('No .log files selected.');
    return;
  }
  if (uris.length === 1) {
    await vscode.commands.executeCommand('vscode.openWith', uris[0], LOG_VIEW_TYPE);
    return;
  }
  if (total > MERGE_CONFIRM_BYTES) {
    const mb = Math.round(total / (1024 * 1024)).toLocaleString('en-US');
    const choice = await vscode.window.showWarningMessage(
      `The ${uris.length} files total ${mb} MB. Merging them can take a while and use a lot of memory.`,
      { modal: true }, 'Open');
    if (choice !== 'Open') return;
  }

  const files = uris;
  // showLogWebview sets the webview options (scripts, resource roots).
  const panel = vscode.window.createWebviewPanel(MERGED_VIEW_TYPE, `Logs (${files.length} files)`, vscode.ViewColumn.Active,
    { retainContextWhenHidden: true });
  const host = new LogSessionHost(files.map(u => u.fsPath), 'the merged logs');
  showLogWebview(ctx.extensionUri, panel, host, () => openAsText(files));
  panel.onDidDispose(() => host.dispose());
}

export function registerLogViewer(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(LOG_VIEW_TYPE, new LogViewerProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('iecode.logViewer.open', (arg?: unknown) => {
      const uri = targetUri(arg);
      if (!uri) return vscode.window.showInformationMessage('Open a log file first.');
      return vscode.commands.executeCommand('vscode.openWith', uri, LOG_VIEW_TYPE);
    }),
    // The explorer passes the clicked resource and the whole selection.
    vscode.commands.registerCommand('iecode.logViewer.openMerged', (arg?: unknown, selection?: unknown) =>
      openMerged(ctx, arg, selection)),
    // Keybindings instead of keydown handlers in the webview: its key presses reach the workbench too, so F8 would
    // also run "Go to Next Problem".
    ...PANEL_COMMANDS.map(command => vscode.commands.registerCommand(`iecode.logViewer.${command}`, () => {
      for (const p of panels) if (p.active) return p.webview.postMessage({ type: 'command', command });
    })),
  );
}
