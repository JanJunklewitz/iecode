// Read-only viewer for log files: a virtual-scrolled table on top of LogSession (src/core/logsession.ts).
// A readonly custom editor with its own document, because VS Code does not hand 100 MB files to a text editor.
// The document owns the session; the panel owns only its subscriptions (one panel per document).

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { LogFormatDef, parseFilterTimeInput } from '../core/logformat';
import { LogSession, SessionFilters, StaleError } from '../core/logsession';
import { ViewOptions } from '../core/logview';

export const LOG_VIEW_TYPE = 'iecode.logViewer';

/**
 * Webview -> host. In `filters`, the time bounds come as the raw input text (fromText / toText; '' = open end); the
 * host parses them and answers each one with {type: 'filterError', field: 'from' | 'to', message} ('' = valid), and
 * an invalid bound leaves the applied one unchanged.
 */
type Msg =
  | { type: 'ready' }
  | { type: 'rows'; rev: number; pos: number; count: number; id: number }
  | ({ type: 'filters'; fromText?: string; toText?: string } & Partial<Omit<SessionFilters, 'from' | 'to'>>)
  | ({ type: 'options' } & Partial<ViewOptions>)
  | { type: 'detail'; rev: number; pos: number }
  | { type: 'jump'; rev: number; from: number; dir: 1 | -1; what: 'error' | 'bookmark' }
  | { type: 'bookmark'; rev: number; pos: number }
  | { type: 'live'; on: boolean }
  | { type: 'export' }
  | { type: 'openRaw' };

/** Most rows one request may ask for (the webview asks for windows of about 200). */
const MAX_ROWS_PER_REQUEST = 1000;
/** Least time between two state messages while the file is scanned. */
const PROGRESS_INTERVAL_MS = 100;

function userFormats(): LogFormatDef[] {
  const v = vscode.workspace.getConfiguration('iecode.logViewer').get<unknown>('formats');
  if (!Array.isArray(v)) return [];
  return v.filter((f): f is LogFormatDef =>
    !!f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.entry === 'string');
}

function viewOptions(): ViewOptions {
  const c = vscode.workspace.getConfiguration('iecode.logViewer');
  const gapSeconds = c.get<number>('gapSeconds', 5);
  return { groupRepeats: c.get<boolean>('groupRepeats', false), gapMs: Math.max(0, Number(gapSeconds) || 0) * 1000 };
}

/** Owns the session behind one log viewer webview. */
class LogSessionHost {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the session state changed (load progress, load end, filters, options, bookmarks). */
  readonly onDidChangeState = this.changed.event;
  readonly session?: LogSession;
  /** Set when nothing can be shown at all (scheme, load failure). */
  failure?: string;

  /** Without paths, `failure` says why nothing is shown; `label` names the content in a load failure. */
  constructor(paths: string[] | undefined, private readonly label: string, failure?: string) {
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
    this.changed.fire();
  }

  notify() {
    this.changed.fire();
  }

  dispose() {
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
      if (m.type === 'openRaw') return openRaw();
      if (m.type === 'ready') return sendState();
      const s = doc.session;
      if (!s || doc.failure !== undefined) return;
      try {
        switch (m.type) {
          case 'rows': {
            const rows = await s.rows(m.rev, m.pos, Math.max(0, Math.min(m.count, MAX_ROWS_PER_REQUEST)));
            return post({ type: 'rows', rev: m.rev, id: m.id, pos: m.pos, rows });
          }
          case 'filters': {
            const { type: _type, fromText, toText, ...rest } = m;
            const f: Partial<SessionFilters> = rest;
            for (const [field, text] of [['from', fromText], ['to', toText]] as const) {
              if (text === undefined) continue;
              const t = parseFilterTimeInput(text);
              post({ type: 'filterError', field, message: t.error ?? '' });
              // An own undefined member opens the bound (setFilters spreads the patch over the filters).
              if (t.error === undefined) f[field] = t.ms;
            }
            if (Object.keys(f).length === 0) return;
            // Level, time and source changes publish before the first await; a text search publishes later,
            // and a failing search only sets state.error, so the state goes out after both steps.
            const done = s.setFilters(f);
            doc.notify();
            await done;
            return doc.notify();
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
          case 'jump':
            return post({ type: 'jumped', rev: m.rev, pos: s.jump(m.rev, m.from, m.dir, m.what) });
          case 'bookmark':
            // The revision stays; the state message makes the webview fetch the rows' bookmark flags again.
            s.toggleBookmark(m.rev, m.pos);
            return doc.notify();
          case 'live':
            s.setLive(m.on);
            return doc.notify();
          case 'export':
            return post({ type: 'error', message: 'Export is not available yet.' });
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
    // Keybindings instead of keydown handlers in the webview: its key presses reach the workbench too, so F8 would
    // also run "Go to Next Problem".
    ...PANEL_COMMANDS.map(command => vscode.commands.registerCommand(`iecode.logViewer.${command}`, () => {
      for (const p of panels) if (p.active) return p.webview.postMessage({ type: 'command', command });
    })),
  );
}
