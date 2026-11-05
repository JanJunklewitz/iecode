// Read-only viewer for TwinCAT Module Class files (.tmc), the build output of a PLC project or TcCOM module: its tasks,
// data areas, symbols and data types. A custom (not text) editor, because a .tmc can exceed the 50 MB up to which
// VS Code hands text documents to extensions. Reloads by itself when a build writes the file again.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { decodeTmc, parseTmc } from '../core/tmc';

export const TMC_VIEW_TYPE = 'iecode.tmcViewer';

type Msg = { type: 'ready' } | { type: 'openXml' };

class TmcViewerProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const res = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${res('tmcViewer.css')}"></head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${res('tmcViewer.js')}"></script></body></html>`;

    const file = path.basename(doc.uri.path);
    const send = async () => {
      try {
        const model = parseTmc(decodeTmc(await vscode.workspace.fs.readFile(doc.uri)));
        await panel.webview.postMessage({ type: 'model', model, file });
      } catch (e) {
        // the webview keeps a previous version: the file may be mid-write during a build
        await panel.webview.postMessage({ type: 'error', message: (e as Error).message, file });
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const reload = () => { clearTimeout(timer); timer = setTimeout(() => void send(), 400); };
    const subs: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((m: Msg) => {
        if (m.type === 'ready') return void send();
        if (m.type === 'openXml') return void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
      }),
    ];
    if (doc.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(doc.uri, '..'), file));
      subs.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));
    }
    panel.onDidDispose(() => { clearTimeout(timer); subs.forEach(s => s.dispose()); });
  }
}

export function registerTmcViewer(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(TMC_VIEW_TYPE, new TmcViewerProvider(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );
}
