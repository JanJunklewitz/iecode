// Visual editor for TwinCAT visualizations (.TcVIS): a canvas with the elements (move, resize, edit
// properties), a simplified list of what each element shows and does, and the YAML summary as text.
// Edits go through the text document (WorkspaceEdit), so undo / redo / save / dirty state work as for text.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Visu, VisuEdit, VisuEditError, editRanges, parseVisu, visuToText } from '../core/tcvis';

export const VISU_VIEW_TYPE = 'iecode.visuEditor';
export const VISU_TEXT_SCHEME = 'iecode-visu';

type Msg =
  | { type: 'ready' }
  | { type: 'edit'; edits: VisuEdit[] }
  | { type: 'refs'; names: string[] }
  | { type: 'openRef'; name: string }
  | { type: 'openXml' }
  | { type: 'openText' };

/** iecode-visu:/path/X.TcVIS.yaml?file=<uri> shows the YAML summary of a visualization (open document or file). */
export const visuTextUri = (file: vscode.Uri) =>
  vscode.Uri.from({ scheme: VISU_TEXT_SCHEME, path: file.path + '.yaml', query: new URLSearchParams({ file: file.toString() }).toString() });

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Visualizations in the workspace by name (without namespace), parsed on demand and cached by version. */
class VisuIndex implements vscode.Disposable {
  private files?: Thenable<Map<string, vscode.Uri[]>>;
  private parsed = new Map<string, { mtime: number; visu: Visu | null }>();
  private watcher = vscode.workspace.createFileSystemWatcher('**/*.TcVIS');
  private subs = [this.watcher.onDidCreate(() => (this.files = undefined)), this.watcher.onDidDelete(() => (this.files = undefined))];

  dispose() { this.watcher.dispose(); this.subs.forEach(s => s.dispose()); }

  private index() {
    return (this.files ??= vscode.workspace.findFiles('**/*.TcVIS', '**/node_modules/**').then(uris => {
      const m = new Map<string, vscode.Uri[]>();
      for (const u of uris) {
        const k = path.basename(u.path).replace(/\.TcVIS$/i, '').toLowerCase();
        m.set(k, [...(m.get(k) ?? []), u]);
      }
      return m;
    }));
  }

  /** The file of a referenced visualization ("Lib.VI_X" or "VI_X"), preferring one near `from`. */
  async find(name: string, from: vscode.Uri): Promise<vscode.Uri | undefined> {
    const cands = (await this.index()).get(name.split('.').pop()!.toLowerCase()) ?? [];
    const common = (u: vscode.Uri) => { let i = 0; while (i < u.path.length && u.path[i] === from.path[i]) i++; return i; };
    return [...cands].sort((a, b) => common(b) - common(a))[0];
  }

  async load(name: string, from: vscode.Uri): Promise<Visu | null> {
    const uri = await this.find(name, from);
    if (!uri) return null;
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    const stamp = open ? -open.version : (await vscode.workspace.fs.stat(uri).then(s => s.mtime, () => 0));
    const hit = this.parsed.get(uri.toString());
    if (hit && hit.mtime === stamp) return hit.visu;
    let visu: Visu | null = null;
    try {
      const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      visu = parseVisu(text);
    } catch { /* not readable: shown as a plain frame */ }
    this.parsed.set(uri.toString(), { mtime: stamp, visu });
    return visu;
  }
}

class VisuEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext, private index: VisuIndex) {}

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const res = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${res('visuEditor.css')}"></head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${res('visuEditor.js')}"></script></body></html>`;

    const post = (m: unknown) => panel.webview.postMessage(m);
    const send = () => {
      try {
        post({ type: 'model', visu: parseVisu(doc.getText()), file: path.basename(doc.uri.fsPath) });
      } catch (e) {
        post({ type: 'error', message: `Cannot show this visualization: ${(e as Error).message}` });
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const subs = [
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== doc.uri.toString() || !e.contentChanges.length) return;
        clearTimeout(timer);
        timer = setTimeout(send, 150);
      }),
      panel.webview.onDidReceiveMessage(async (m: Msg) => {
        switch (m.type) {
          case 'ready': return send();
          case 'edit': return this.edit(doc, m.edits, post);
          case 'refs': {
            const visus: Record<string, Visu | null> = {};
            for (const n of m.names.slice(0, 200)) visus[n] = await this.index.load(n, doc.uri);
            return post({ type: 'refs', visus });
          }
          case 'openRef': {
            const uri = await this.index.find(m.name, doc.uri);
            if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, VISU_VIEW_TYPE);
            return vscode.window.showInformationMessage(`IECode: visualization ${m.name} is not in this workspace (library?).`);
          }
          case 'openXml': return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
          case 'openText': return vscode.window.showTextDocument(visuTextUri(doc.uri), { preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
      }),
    ];
    panel.onDidDispose(() => { clearTimeout(timer); subs.forEach(s => s.dispose()); });
  }

  private async edit(doc: vscode.TextDocument, edits: VisuEdit[], post: (m: unknown) => void) {
    const text = doc.getText();
    const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let ranges: [number, number, string][];
    try {
      ranges = editRanges(stripBom(text), edits);
    } catch (e) {
      post({ type: 'error', message: e instanceof VisuEditError ? e.message : `Edit failed: ${(e as Error).message}` });
      return post({ type: 'model', visu: parseVisu(text), file: path.basename(doc.uri.fsPath) });
    }
    const we = new vscode.WorkspaceEdit();
    for (const [s, e, r] of ranges) we.replace(doc.uri, new vscode.Range(doc.positionAt(s + bom), doc.positionAt(e + bom)), r);
    await vscode.workspace.applyEdit(we);
  }
}

export function registerVisuEditor(ctx: vscode.ExtensionContext) {
  const index = new VisuIndex();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(index, changed,
    vscode.window.registerCustomEditorProvider(VISU_VIEW_TYPE, new VisuEditorProvider(ctx, index), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(VISU_TEXT_SCHEME, {
      onDidChange: changed.event,
      async provideTextDocumentContent(uri) {
        const file = vscode.Uri.parse(new URLSearchParams(uri.query).get('file') ?? '');
        try {
          const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === file.toString());
          const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
          return visuToText(parseVisu(text));
        } catch (e) {
          return `# ${(e as Error).message}\n`;
        }
      },
    }),
    // keep open summaries in sync with unsaved edits in the visual editor
    vscode.workspace.onDidChangeTextDocument(e => {
      if (/\.TcVIS$/i.test(e.document.uri.path)) changed.fire(visuTextUri(e.document.uri));
    }),
    vscode.commands.registerCommand('iecode.openVisuEditor', (u?: vscode.Uri) => {
      u ??= vscode.window.activeTextEditor?.document.uri;
      if (u) return vscode.commands.executeCommand('vscode.openWith', u, VISU_VIEW_TYPE);
    }),
    vscode.commands.registerCommand('iecode.openVisuText', (u?: vscode.Uri) => {
      u ??= vscode.window.activeTextEditor?.document.uri;
      if (u) return vscode.window.showTextDocument(visuTextUri(u), { preview: false });
    }),
  );
}
