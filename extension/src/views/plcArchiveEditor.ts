// Editor for global text lists (.TcGTLO), image pools (.TcIPO) and the visualization manager (.TcVMO): a table of
// texts with their translations, the images with previews, and the visualization manager's settings as a form.
// Edits go through the text document (WorkspaceEdit), so undo / redo / save / dirty state work as for text.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ArchiveEdit, archiveEditRanges, parsePlcArchive } from '../core/plcArchive';
import { VisuEditError } from '../core/tcvis';
import { visuTextUri } from './visuEditor';

export const ARCHIVE_VIEW_TYPE = 'iecode.plcArchiveEditor';

type Msg =
  | { type: 'ready' }
  | { type: 'edit'; edits: ArchiveEdit[] }
  | { type: 'openXml' }
  | { type: 'openText' }
  | { type: 'openImage'; path: string };

/** The folder of the PLC project a file belongs to (image paths are relative to it), else the file's folder. */
async function plcDir(file: vscode.Uri): Promise<vscode.Uri> {
  for (let dir = vscode.Uri.joinPath(file, '..'); ; ) {
    const entries = await vscode.workspace.fs.readDirectory(dir).then(e => e, () => []);
    if (entries.some(([n]) => /\.plcproj$/i.test(n))) return dir;
    const up = vscode.Uri.joinPath(dir, '..');
    if (up.path === dir.path) return vscode.Uri.joinPath(file, '..');
    dir = up;
  }
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

class PlcArchiveEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const project = await plcDir(doc.uri);
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, project] };
    const nonce = randomBytes(16).toString('hex');
    const res = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const csp = panel.webview.cspSource;
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${res('plcArchiveEditor.css')}"></head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${res('plcArchiveEditor.js')}"></script></body></html>`;

    const post = (m: unknown) => panel.webview.postMessage(m);
    let visus: string[] | undefined;
    const send = async () => {
      try {
        const model = parsePlcArchive(doc.getText());
        // start visualization: offer the workspace's visualizations
        if (model.kind === 'visumanager') visus ??= (await vscode.workspace.findFiles('**/*.TcVIS', '**/node_modules/**'))
          .map(u => path.basename(u.path).replace(/\.TcVIS$/i, '')).sort();
        post({ type: 'model', model, file: path.basename(doc.uri.fsPath), imageBase: panel.webview.asWebviewUri(project).toString(), visus: visus ?? [] });
      } catch (e) {
        post({ type: 'error', message: `Cannot show this file: ${(e as Error).message}` });
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const subs = [
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== doc.uri.toString() || !e.contentChanges.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => void send(), 150);
      }),
      panel.webview.onDidReceiveMessage(async (m: Msg) => {
        switch (m.type) {
          case 'ready': return send();
          case 'edit': return this.edit(doc, m.edits, post, send);
          case 'openXml': return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
          case 'openText': return vscode.window.showTextDocument(visuTextUri(doc.uri), { preview: false, viewColumn: vscode.ViewColumn.Beside });
          case 'openImage': return vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(project, ...m.path.split('/')));
        }
      }),
    ];
    panel.onDidDispose(() => { clearTimeout(timer); subs.forEach(s => s.dispose()); });
  }

  private async edit(doc: vscode.TextDocument, edits: ArchiveEdit[], post: (m: unknown) => void, resend: () => Promise<void>) {
    const text = doc.getText();
    const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let ranges: [number, number, string][];
    try {
      ranges = archiveEditRanges(stripBom(text), edits);
    } catch (e) {
      await resend();   // reverts the inputs; the model clears the status, so the error goes after it
      return post({ type: 'error', message: e instanceof VisuEditError ? e.message : `Edit failed: ${(e as Error).message}` });
    }
    const we = new vscode.WorkspaceEdit();
    for (const [s, e, r] of ranges) we.replace(doc.uri, new vscode.Range(doc.positionAt(s + bom), doc.positionAt(e + bom)), r);
    await vscode.workspace.applyEdit(we);
  }
}

export function registerPlcArchiveEditor(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ARCHIVE_VIEW_TYPE, new PlcArchiveEditorProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}
