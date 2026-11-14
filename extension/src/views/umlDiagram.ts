// UML class diagram of function blocks and interfaces (from the language index), with Mermaid / PlantUML / SVG export.

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { WorkspaceState } from '../state';
import type { LanguageApi } from '../lang/providers';
import type { Node } from './tree';
import { UmlDetail, UmlScope, describeModel, toMermaid, toPlantUml, toSvg, umlModel } from '../lang/uml';

interface Target { title: string; scope: UmlScope }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function pickTarget(state: WorkspaceState, lang: LanguageApi, n?: Node | vscode.Uri): Promise<Target | undefined> {
  await lang.ready();
  const units = state.current.units;
  if (n instanceof vscode.Uri || !n) {
    const uri = n instanceof vscode.Uri ? n : vscode.window.activeTextEditor?.document.uri;
    const name = uri && lang.index.get(uri.fsPath)?.root?.name;
    if (name) return { title: name, scope: { focus: [name] } };
    const pick = await vscode.window.showQuickPick([
      { label: 'Whole workspace', target: { title: 'Workspace', scope: {} } as Target },
      ...units.map(u => ({ label: u.id, description: u.group, target: { title: u.id, scope: { files: new Set(u.plc.objects.map(o => o.file)) } } as Target })),
    ], { title: 'UML class diagram of' });
    return pick?.target;
  }
  switch (n.kind) {
    case 'unit': return { title: n.unit.id, scope: { files: new Set(n.unit.plc.objects.map(o => o.file)) } };
    case 'folder': return { title: `${n.unit.id}/${n.rel}`, scope: { files: new Set(n.unit.plc.objects.filter(o => o.rel.startsWith(n.rel + '/')).map(o => o.file)) } };
    case 'group': return { title: n.group, scope: { files: new Set(n.units.flatMap(u => u.plc.objects.map(o => o.file))) } };
    case 'object': return { title: n.obj.name, scope: { focus: [n.obj.name] } };
    case 'libraryObject': return { title: n.obj.name, scope: { focus: [n.obj.name] } };
    default: return undefined;
  }
}

export function registerUml(ctx: vscode.ExtensionContext, state: WorkspaceState, lang: LanguageApi) {
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.umlDiagram', async (n?: Node | vscode.Uri) => {
    const target = await pickTarget(state, lang, n);
    if (target) show(ctx, state, lang, target);
  }));
}

function show(ctx: vscode.ExtensionContext, state: WorkspaceState, lang: LanguageApi, target: Target) {
  const panel = vscode.window.createWebviewPanel('iecode.uml', `UML: ${target.title}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  let detail: UmlDetail = 'members';
  const model = () => umlModel(lang.index, target.scope);
  const render = () => {
    const m = model();
    if (!m.classes.length) {
      panel.webview.html = page(panel.webview, target.title, '<p class="empty">No function blocks or interfaces here.</p>', detail, '');
      return;
    }
    panel.webview.html = page(panel.webview, target.title, toSvg(m, detail), detail, describeModel(m));
  };
  render();

  const save = async (text: string, ext: string, label: string) => {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: base && vscode.Uri.joinPath(base, `${target.title.replace(/[^\w.-]+/g, '_')}.${ext}`),
      filters: { [label]: [ext] },
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  };
  panel.webview.onDidReceiveMessage(async (msg: { type: string; value?: string; file?: string }) => {
    const m = model();
    switch (msg.type) {
      case 'detail': detail = (msg.value as UmlDetail) ?? 'members'; render(); break;
      case 'copyMermaid': await vscode.env.clipboard.writeText(toMermaid(m, detail)); void vscode.window.showInformationMessage('IECode: Mermaid class diagram copied.'); break;
      case 'saveMermaid': await save(toMermaid(m, detail), 'mmd', 'Mermaid'); break;
      case 'savePlantUml': await save(toPlantUml(m, detail), 'puml', 'PlantUML'); break;
      case 'saveSvg': await save(toSvg(m, detail), 'svg', 'SVG'); break;
      case 'open': if (msg.file) await vscode.commands.executeCommand('iecode.openAsST', vscode.Uri.file(msg.file)); break;
    }
  }, undefined, ctx.subscriptions);

  // follow edits: re-render after saves and workspace changes
  let timer: NodeJS.Timeout | undefined;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { void lang.ready().then(render); }, 300); };
  const subs = [state.onDidChange(later), vscode.workspace.onDidSaveTextDocument(later)];
  panel.onDidDispose(() => { clearTimeout(timer); subs.forEach(s => s.dispose()); });
}

function page(webview: vscode.Webview, title: string, body: string, detail: UmlDetail, summary: string): string {
  const nonce = randomBytes(16).toString('base64');
  const opt = (v: UmlDetail, label: string) => `<option value="${v}"${v === detail ? ' selected' : ''}>${label}</option>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
.bar{position:sticky;top:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);z-index:1}
.bar h1{font-size:13px;margin:0 8px 0 0}.bar .sum{opacity:.7;margin-right:auto;font-size:12px}
button,select{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:3px 8px;cursor:pointer;font:inherit;font-size:12px}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.canvas{overflow:auto;padding:10px}.canvas svg{transform-origin:0 0}
g[data-file]{cursor:pointer}g[data-file]:hover rect{stroke:var(--vscode-focusBorder);stroke-width:2}
.empty{padding:20px;opacity:.7}
</style></head><body>
<div class="bar"><h1>${esc(title)}</h1><span class="sum">${esc(summary)}</span>
<select id="detail" title="Detail">${opt('names', 'Names only')}${opt('members', 'Methods & properties')}${opt('full', 'All members')}</select>
<button data-zoom="-1" title="Zoom out">−</button><button data-zoom="1" title="Zoom in">+</button>
<button data-cmd="copyMermaid">Copy Mermaid</button><button data-cmd="saveMermaid">Save .mmd</button><button data-cmd="savePlantUml">Save .puml</button><button data-cmd="saveSvg">Save .svg</button></div>
<div class="canvas">${body}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let zoom = (vscode.getState() || {}).zoom || 1;
const svg = document.querySelector('.canvas svg');
const apply = () => { if (svg) { svg.style.transform = 'scale(' + zoom + ')'; svg.parentElement.style.height = (svg.getBBox ? svg.height.baseVal.value * zoom + 20 : 0) + 'px'; } vscode.setState({ zoom }); };
apply();
document.getElementById('detail').addEventListener('change', e => vscode.postMessage({ type: 'detail', value: e.target.value }));
document.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.cmd })));
document.querySelectorAll('button[data-zoom]').forEach(b => b.addEventListener('click', () => { zoom = Math.min(3, Math.max(0.25, zoom * (b.dataset.zoom === '1' ? 1.25 : 0.8))); apply(); }));
document.querySelectorAll('g[data-file]').forEach(g => g.addEventListener('click', () => vscode.postMessage({ type: 'open', file: g.dataset.file })));
</script></body></html>`;
}
