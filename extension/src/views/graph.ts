import * as vscode from 'vscode';
import { WorkspaceModel, buildOrder } from '../core/workspace';
import { WorkspaceState } from '../state';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Dependency graph of the workspace: one column per level (libraries left, applications right). */
export function showGraph(state: WorkspaceState) {
  const panel = vscode.window.createWebviewPanel('iecode.graph', 'IECode: Dependencies', vscode.ViewColumn.Active, { enableScripts: false });
  const render = (m: WorkspaceModel) => (panel.webview.html = html(m));
  render(state.current);
  const sub = state.onDidChange(render);
  panel.onDidDispose(() => sub.dispose());
}

export function levels(m: Pick<WorkspaceModel, 'units' | 'edges'>): string[][] {
  const order = buildOrder(m);
  const level = new Map<string, number>();
  for (const id of order) {
    const deps = m.edges.filter(e => e.from === id).map(e => level.get(e.to) ?? 0);
    level.set(id, deps.length ? Math.max(...deps) + 1 : 0);
  }
  const cols: string[][] = [];
  for (const id of order) (cols[level.get(id)!] ??= []).push(id);
  return cols;
}

function html(m: WorkspaceModel): string {
  let cols: string[][];
  let error = '';
  try { cols = levels(m); } catch (e) { cols = [m.units.map(u => u.id)]; error = (e as Error).message; }
  const unit = (id: string) => m.units.find(u => u.id === id)!;
  const card = (id: string) => {
    const u = unit(id);
    const uses = m.edges.filter(e => e.from === id)
      .map(e => `<li class="${e.link}">${esc(unit(e.to).plc.title ?? e.to)} <span>${e.link === 'workspace' ? '⇄ workspace' : 'pinned ' + esc(e.ref.effective.version)}</span></li>`).join('');
    return `<div class="card ${u.group}"><div class="t">${esc(u.plc.isLibrary ? (u.plc.title ?? id) : id)}</div>
      <div class="d">${u.plc.isLibrary ? 'library ' + esc(u.plc.version ?? '') : u.group}</div>${uses ? `<ul>${uses}</ul>` : ''}</div>`;
  };
  const order = (() => { try { return buildOrder(m).join(' → '); } catch { return ''; } })();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}
.cols{display:flex;gap:28px;align-items:flex-start;overflow-x:auto}
.col{display:flex;flex-direction:column;gap:10px;min-width:200px}
.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px;background:var(--vscode-editorWidget-background)}
.card.library{border-left:3px solid var(--vscode-charts-blue)} .card.application{border-left:3px solid var(--vscode-charts-green)} .card.standalone{border-left:3px solid var(--vscode-charts-orange)}
.t{font-weight:600}.d{opacity:.7;font-size:12px}
ul{margin:6px 0 0;padding-left:16px;font-size:12px} li span{opacity:.7} li.pinned span{color:var(--vscode-charts-yellow)}
.order{margin-top:16px;opacity:.8;font-size:12px}.err{color:var(--vscode-errorForeground)}
</style></head><body>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${m.units.length ? `<div class="cols">${cols.map(c => `<div class="col">${c.map(card).join('')}</div>`).join('')}</div>` : '<p>No TwinCAT projects in this workspace.</p>'}
${order ? `<div class="order">Build order: ${esc(order)}</div>` : ''}
</body></html>`;
}
