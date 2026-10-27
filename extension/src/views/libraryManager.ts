// NuGet-style library manager: Installed / Updates / Consolidate / Browse, editing the .plcproj files.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { WorkspaceState } from '../state';
import { Available, addReference, overview, removeReference, scanFolder, scanRepository } from '../core/libraries';
import { setLibraryVersion } from '../core/references';

type Msg =
  | { type: 'refresh' }
  | { type: 'setVersion'; lib: string; vendor: string; version: string; plcFiles: string[] }
  | { type: 'add'; lib: string; vendor: string; version: string; plcFile: string }
  | { type: 'remove'; lib: string; plcFiles: string[] }
  | { type: 'settings' };

export function repositoryPaths(): { repo?: string; folders: string[] } {
  const cfg = vscode.workspace.getConfiguration('iecode');
  const tc = process.env.TWINCAT3DIR;
  const repo = cfg.get<string>('libraryRepository', '') || (tc ? path.join(tc, 'Components', 'Plc', 'Managed Libraries') : undefined);
  return { repo, folders: cfg.get<string[]>('librarySources', []) };
}

/** Libraries in the repository and the configured library folders. */
export async function availableLibraries(): Promise<Available[]> {
  const { repo, folders } = repositoryPaths();
  const all = [...(repo ? await scanRepository(repo) : [])];
  for (const f of folders) all.push(...await scanFolder(f));
  return all;
}

let panel: vscode.WebviewPanel | undefined;

export function showLibraryManager(ctx: vscode.ExtensionContext, state: WorkspaceState, focusLib?: string) {
  if (panel) { panel.reveal(); if (focusLib) panel.webview.postMessage({ type: 'focus', lib: focusLib }); return; }
  panel = vscode.window.createWebviewPanel('iecode.libraries', 'IECode: Libraries', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);

  const post = async () => {
    const rows = overview(state.current, await availableLibraries());
    const units = state.current.units.map(u => ({ id: u.id, plcFile: u.plc.file, group: u.group }));
    const { repo, folders } = repositoryPaths();
    panel?.webview.postMessage({ type: 'state', rows, units, sources: { repo, folders }, focus: focusLib });
    focusLib = undefined;
  };

  const edit = async (file: string, fn: (t: string) => string) => {
    const raw = await fs.readFile(file, 'utf8');
    const out = fn(raw);
    if (out !== raw) await fs.writeFile(file, out, 'utf8');
  };

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    try {
      if (m.type === 'refresh') await state.reload();
      else if (m.type === 'settings') return void vscode.commands.executeCommand('workbench.action.openSettings', 'iecode.library');
      else if (m.type === 'setVersion') {
        let n = 0;
        for (const f of m.plcFiles) await edit(f, t => { const r = setLibraryVersion(t, m.lib, m.version, m.vendor || undefined); n += r.changes.length; return r.text; });
        vscode.window.setStatusBarMessage(`$(check) ${m.lib} → ${m.version} in ${m.plcFiles.length} project(s) (${n} change(s))`, 6000);
        await state.reload();
      } else if (m.type === 'add') {
        await edit(m.plcFile, t => addReference(t, { name: m.lib, version: m.version, vendor: m.vendor }));
        await state.reload();
      } else if (m.type === 'remove') {
        const ok = await vscode.window.showWarningMessage(`Remove ${m.lib} from ${m.plcFiles.length} project(s)?`, { modal: true }, 'Remove');
        if (ok !== 'Remove') return;
        for (const f of m.plcFiles) await edit(f, t => removeReference(t, m.lib));
        await state.reload();
      }
    } catch (e) {
      vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
    }
    await post();
  }, undefined, ctx.subscriptions);

  const sub = state.onDidChange(() => void post());
  panel.onDidDispose(() => { sub.dispose(); panel = undefined; });
  void post();
}

export function html(nonce: string, csp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:0}
.top{display:flex;gap:16px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
.tabs button{background:none;border:0;color:var(--vscode-descriptionForeground);font:inherit;padding:4px 0;margin-right:14px;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;font-size:11px}
.tabs button.on{color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-focusBorder)}
.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px;padding:0 6px;margin-left:4px;font-size:10px}
input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit}
#q{flex:1;min-width:160px}
.main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);height:calc(100vh - 50px)}
.list{overflow:auto;border-right:1px solid var(--vscode-panel-border)}
.row{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}
.row:hover{background:var(--vscode-list-hoverBackground)} .row.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.nm{font-weight:600}.vd{opacity:.7;font-size:12px}.ver{text-align:right;font-size:12px;white-space:nowrap}
.up{color:var(--vscode-charts-blue)}.warn{color:var(--vscode-charts-yellow)}.ws{color:var(--vscode-charts-green)}
.det{overflow:auto;padding:14px 16px}
h2{margin:0;font-size:17px} table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px}
td,th{border-bottom:1px solid var(--vscode-panel-border);padding:4px 6px;text-align:left} th{opacity:.7;font-weight:400}
button.b{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 12px;cursor:pointer;font:inherit;margin:2px 4px 2px 0}
button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.empty{padding:20px;opacity:.7}.src{font-size:12px;opacity:.7;margin-top:12px}
</style></head><body>
<div class="top">
  <div class="tabs" id="tabs">
    <button data-t="installed" class="on">Installed</button><button data-t="updates">Updates<span class="badge" id="nUp">0</span></button>
    <button data-t="consolidate">Consolidate<span class="badge" id="nCo">0</span></button><button data-t="browse">Browse</button>
  </div>
  <input id="q" placeholder="Search libraries">
  <button class="b s" id="refresh">Refresh</button><button class="b s" id="settings">Sources…</button>
</div>
<div class="main"><div class="list" id="list"></div><div class="det" id="det"><div class="empty">Select a library.</div></div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let S = { rows: [], units: [], sources: {} }, tab = 'installed', sel = null;
const $ = id => document.getElementById(id);
const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function visible() {
  const q = $('q').value.toLowerCase();
  return S.rows.filter(r => (!q || r.name.toLowerCase().includes(q) || r.vendor.toLowerCase().includes(q)) && (
    tab === 'installed' ? r.usedBy.length : tab === 'updates' ? r.outdated.length : tab === 'consolidate' ? r.inconsistent : r.versions.length || r.workspace));
}
function render() {
  $('nUp').textContent = S.rows.filter(r => r.outdated.length).length;
  $('nCo').textContent = S.rows.filter(r => r.inconsistent).length;
  const rows = visible();
  $('list').innerHTML = rows.length ? rows.map(r => {
    const used = [...new Set(r.usedBy.map(u => u.version))];
    const right = tab === 'browse' ? (r.latest ?? '') : used.join(' · ');
    const flag = r.outdated.length ? '<br><span class="up">↑ ' + e(r.latest) + '</span>' : r.inconsistent ? '<br><span class="warn">' + used.length + ' versions</span>' : r.workspace ? '<br><span class="ws">⇄ workspace</span>' : '';
    return '<div class="row' + (sel === r.name ? ' sel' : '') + '" data-n="' + e(r.name) + '"><div><div class="nm">' + e(r.name) + '</div><div class="vd">' + e(r.vendor) + ' · ' + r.usedBy.length + ' project(s)</div></div><div class="ver">' + e(right) + flag + '</div></div>';
  }).join('') : '<div class="empty">' + (tab === 'updates' ? 'All pinned references are up to date.' : tab === 'consolidate' ? 'Every library is used in one version.' : 'Nothing here.') + '</div>';
  detail();
}
function detail() {
  const r = S.rows.find(x => x.name === sel);
  if (!r) { $('det').innerHTML = '<div class="empty">Select a library.</div>'; return; }
  const opts = ['*', ...r.versions].map(v => '<option value="' + e(v) + '"' + (v === r.latest ? ' selected' : '') + '>' + (v === '*' ? '* (always newest)' : e(v) + (v === r.workspace?.version ? ' (workspace project)' : '')) + '</option>').join('');
  const used = new Map(r.usedBy.map(u => [u.plcFile, u]));
  const rows = S.units.map(u => { const x = used.get(u.plcFile); return '<tr><td><input type="checkbox" class="pk" value="' + e(u.plcFile) + '"' + (x ? ' checked' : '') + '></td><td>' + e(u.id) + '</td><td>' + (x ? e(x.version) + (x.pinned ? '' : ' (newest)') : '—') + '</td></tr>'; }).join('');
  $('det').innerHTML = '<h2>' + e(r.name) + '</h2><div class="vd">' + e(r.vendor) + (r.workspace ? ' · <span class="ws">workspace project ' + e(r.workspace.unit) + ' ' + e(r.workspace.version) + '</span>' : '') + '</div>'
    + '<p>Version <select id="ver">' + opts + '</select></p>'
    + '<table><tr><th></th><th>Project</th><th>Uses</th></tr>' + rows + '</table>'
    + '<button class="b" id="apply">Set version in checked projects</button><button class="b s" id="add">Add to checked projects</button><button class="b s" id="rm">Remove from checked</button>'
    + '<div class="src">Available: ' + (r.versions.length ? r.versions.map(e).join(', ') : 'not found in the configured sources') + '</div>';
  const checked = () => [...document.querySelectorAll('.pk:checked')].map(c => c.value);
  $('apply').onclick = () => vscode.postMessage({ type: 'setVersion', lib: r.name, vendor: r.vendor, version: $('ver').value, plcFiles: checked().filter(f => used.has(f)) });
  $('add').onclick = () => checked().filter(f => !used.has(f)).forEach(f => vscode.postMessage({ type: 'add', lib: r.name, vendor: r.vendor, version: $('ver').value, plcFile: f }));
  $('rm').onclick = () => vscode.postMessage({ type: 'remove', lib: r.name, plcFiles: checked().filter(f => used.has(f)) });
}
$('tabs').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; tab = b.dataset.t; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b)); render(); };
$('list').onclick = ev => { const r = ev.target.closest('.row'); if (r) { sel = r.dataset.n; render(); } };
$('q').oninput = render;
$('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
$('settings').onclick = () => vscode.postMessage({ type: 'settings' });
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'state') { S = m; if (m.focus) sel = S.rows.find(r => r.name.toLowerCase() === m.focus.toLowerCase())?.name ?? sel; render(); }
  if (m.type === 'focus') { sel = S.rows.find(r => r.name.toLowerCase() === m.lib.toLowerCase())?.name ?? sel; render(); }
});
</script></body></html>`;
}
