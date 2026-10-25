// ADS interface view: the symbols an ADS client (HMI, scripts, other PLCs) can access by name, without a
// running PLC. Shown from the build output (.tmc) or straight from the source code (working copy or any
// commit), and compared between any two of them. Reloads by itself when a build writes a new .tmc.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { WorkspaceState } from '../state';
import { PlcProject } from '../core/projects';
import { AdsInterface, adsChangesToCsv, diffInterfaces, findTmc, fromBuild, fromSourceAt, symbolsToCsv, toSnapshot } from '../core/adsinterface';
import { log, repoRoot } from '../core/git';

type Msg =
  | { type: 'ready' }
  | { type: 'project'; plc: string }
  | { type: 'load' | 'export' | 'snapshot'; plc: string; show: string; compare: string; members: boolean };

const BUILD = 'build';
const NONE = '';
const SRC = 'src:';                // 'src:' working copy, 'src:<ref>' at a commit

let panel: vscode.WebviewPanel | undefined;

function plcs(state: WorkspaceState): { plc: PlcProject; label: string }[] {
  const order = { application: 0, standalone: 1, library: 2 };
  return [...state.current.units].sort((a, b) => order[a.group] - order[b.group] || a.id.localeCompare(b.id))
    .map(u => ({ plc: u.plc, label: u.group === 'library' ? `${u.id} (library)` : u.id }));
}

export function showAdsInterface(ctx: vscode.ExtensionContext, state: WorkspaceState, plcproj?: string) {
  if (panel) { panel.reveal(); if (plcproj) panel.webview.postMessage({ type: 'select', plc: plcproj }); return; }
  panel = vscode.window.createWebviewPanel('iecode.adsInterface', 'IECode: ADS Interface', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);
  const post = (m: unknown) => panel?.webview.postMessage(m);
  const find = (file: string) => {
    const plc = plcs(state).find(p => p.plc.file === file)?.plc;
    if (!plc) throw new Error(`PLC project ${file} is no longer in the workspace`);
    return plc;
  };

  const versions = async (plc: PlcProject) => {
    const tmc = await findTmc(plc.file);
    const root = await repoRoot(plc.file);
    const commits = root ? await log(root, [plc.dir], 100) : [];
    return {
      built: !!tmc,
      versions: [
        { ref: BUILD, label: tmc ? `Build output (${path.basename(tmc)})` : 'Build output (not built yet)' },
        { ref: SRC, label: 'Source: working copy' },
        ...(root ? [{ ref: `${SRC}HEAD`, label: 'Source: HEAD' }] : []),
        ...commits.map(c => ({ ref: SRC + c.hash, label: `Source: ${c.short} · ${c.date} · ${c.subject}` })),
      ],
    };
  };

  const load = (plc: PlcProject, ref: string, members: boolean): Promise<AdsInterface> =>
    ref === BUILD ? fromBuild(plc, members) : fromSourceAt(plc, ref.slice(SRC.length) || undefined, members);

  const compute = async (m: { plc: string; show: string; compare: string; members: boolean }) => {
    const plc = find(m.plc);
    const shown = await load(plc, m.show, m.members);
    const info = { stale: shown.stale, origin: shown.origin, file: shown.file && path.basename(shown.file) };
    if (m.compare === NONE) return { mode: 'list' as const, plc, shown, ...info };
    // "compare A with B": changes from B (older / reference) to A (shown)
    const other = await load(plc, m.compare, m.members);
    return { mode: 'diff' as const, plc, shown, changes: diffInterfaces(other, shown), before: other.symbols.length, after: shown.symbols.length, ...info, stale: shown.stale || other.stale };
  };

  const save = async (plc: PlcProject, name: string, content: string, filter: string) => {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(plc.dir, name)), filters: { [filter.toUpperCase()]: [filter] } });
    if (!target) return;
    await fs.writeFile(target.fsPath, content, 'utf8');
    vscode.window.showInformationMessage(`IECode: saved ${path.basename(target.fsPath)}`);
  };

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    try {
      if (m.type === 'ready') {
        const list = plcs(state);
        const first = list.find(p => p.plc.file === plcproj) ?? list[0];
        post({ type: 'projects', projects: list.map(p => ({ file: p.plc.file, name: p.label })), selected: first?.plc.file });
        if (first) post({ type: 'versions', plc: first.plc.file, ...(await versions(first.plc)) });
      } else if (m.type === 'project') {
        post({ type: 'versions', plc: m.plc, ...(await versions(find(m.plc))) });
      } else if (m.type === 'load') {
        const r = await compute(m);
        post({ type: 'result', ...r, plc: undefined, shown: undefined, symbols: r.shown.symbols });
      } else if (m.type === 'export') {
        const r = await compute(m);
        if (r.mode === 'list') await save(r.plc, `${r.plc.name}-ads-interface.csv`, '﻿' + symbolsToCsv(r.shown.symbols), 'csv');
        else await save(r.plc, `${r.plc.name}-ads-interface-changes.csv`, '﻿' + adsChangesToCsv(r.changes), 'csv');
      } else if (m.type === 'snapshot') {
        const r = await compute({ ...m, compare: NONE });
        await save(r.plc, `${r.plc.name}.ads-interface.json`, toSnapshot(r.plc.name, r.shown.symbols, m.members), 'json');
      }
    } catch (e) {
      post({ type: 'error', message: (e as Error).message });
    }
  }, undefined, ctx.subscriptions);

  // a finished build rewrites <PLC>.tmc: show the new interface
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.tmc');
  let timer: NodeJS.Timeout | undefined;
  const rebuilt = (u: vscode.Uri) => { clearTimeout(timer); timer = setTimeout(() => post({ type: 'rebuilt', dir: path.dirname(u.fsPath) }), 500); };
  watcher.onDidChange(rebuilt); watcher.onDidCreate(rebuilt);

  panel.onDidDispose(() => { panel = undefined; clearTimeout(timer); watcher.dispose(); });
}

export function html(nonce: string, csp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:0}
.top{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit;max-width:340px}
#q{flex:1;min-width:140px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 12px;cursor:pointer;font:inherit}
button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.sum{padding:8px 14px;opacity:.8;font-size:12px}.warn{color:var(--vscode-editorWarning-foreground);opacity:1}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top;word-break:break-word}
th{position:sticky;top:0;background:var(--vscode-editor-background);opacity:.85;font-weight:600}
td.n{font-family:var(--vscode-editor-font-family)}td.r{text-align:right;white-space:nowrap}
.k{font-weight:600;white-space:nowrap}.added{color:var(--vscode-gitDecoration-addedResourceForeground)}
.removed{color:var(--vscode-gitDecoration-deletedResourceForeground)}.changed{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.dim{opacity:.6}.err{color:var(--vscode-errorForeground);padding:14px}.empty{padding:14px;opacity:.7}
label{font-size:12px;opacity:.8}
</style></head><body>
<div class="top">
  <label>PLC</label><select id="plc"></select>
  <label>Show</label><select id="show"></select><label>compared with</label><select id="cmp"></select>
  <input id="q" placeholder="Filter (name, type, comment)">
  <label><input type="checkbox" id="mem"> members</label>
  <button class="s" id="csv">Export CSV</button>
  <button class="s" id="snap" title="JSON snapshot for: iecode ads diff --against <file> --fail-on-change">Save snapshot</button>
</div>
<div class="sum" id="sum"></div>
<div id="out"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const size = b => b === undefined || b === null ? '' : b % 8 === 0 ? (b / 8) + ' B' : b + ' bit';
let R = null, plcDir = '';
function req(type) { const m = { type, plc: $('plc').value, show: $('show').value, compare: $('cmp').value, members: $('mem').checked }; if (m.plc) vscode.postMessage(m); }
function render() {
  if (!R) return;
  const q = $('q').value.toLowerCase();
  const hit = (...xs) => !q || xs.some(x => (x ?? '').toLowerCase().includes(q));
  const stale = R.stale ? '<span class="warn">⚠ Source files are newer than the build output – build again for the current interface. </span>' : '';
  const from = R.origin === 'build' ? 'from ' + e(R.file) : 'from the source code (no sizes; library types are not expanded)';
  if (R.mode === 'list') {
    const rows = R.symbols.filter(s => hit(s.name, s.type, s.comment));
    $('sum').innerHTML = stale + rows.length + ' of ' + R.symbols.length + ' symbol(s) ' + from;
    $('out').innerHTML = rows.length ? '<table><tr><th>Name</th><th>Type</th><th>Size</th><th>Area</th><th>Comment</th></tr>' + rows.map(s =>
      '<tr><td class="n">' + e(s.name) + '</td><td>' + e(s.type) + '</td><td class="r dim">' + size(s.bitSize) + '</td><td class="dim">' + e(s.area) + '</td><td class="dim">' + e(s.comment) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">' + (R.symbols.length ? 'No symbol matches the filter.' : 'No ADS symbols in this version.') + '</div>';
  } else {
    const rows = R.changes.filter(c => hit(c.name, c.before, c.after));
    const n = k => R.changes.filter(c => c.kind === k).length;
    $('sum').innerHTML = stale + R.before + ' → ' + R.after + ' symbol(s) · ' + n('added') + ' added · ' + n('removed') + ' removed · ' + n('changed') + ' changed';
    $('out').innerHTML = rows.length ? '<table><tr><th></th><th>Name</th><th>Before</th><th>Now</th></tr>' + rows.map(c =>
      '<tr><td class="k ' + c.kind + '">' + c.kind + '</td><td class="n">' + e(c.name) + '</td><td>' + e(c.before) + '</td><td>' + e(c.kind === 'changed' ? c.details : c.after) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">' + (R.changes.length ? 'No change matches the filter.' : 'No differences in the ADS interface.') + '</div>';
  }
}
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'projects') {
    $('plc').innerHTML = m.projects.length ? m.projects.map(p => '<option value="' + e(p.file) + '">' + e(p.name) + '</option>').join('') : '<option value="">(no PLC project)</option>';
    if (m.selected) $('plc').value = m.selected;
    if (!m.projects.length) $('out').innerHTML = '<div class="empty">No PLC project (.plcproj) in this workspace.</div>';
  }
  if (m.type === 'select') { $('plc').value = m.plc; vscode.postMessage({ type: 'project', plc: m.plc }); }
  if (m.type === 'versions') {
    const opts = m.versions.map(v => '<option value="' + e(v.ref) + '">' + e(v.label) + '</option>').join('');
    $('show').innerHTML = opts; $('cmp').innerHTML = '<option value="">(nothing)</option>' + opts;
    $('show').value = m.built ? 'build' : 'src:'; $('cmp').value = '';
    plcDir = m.plc.replace(/[\\\\/][^\\\\/]*$/, '');
    req('load');
  }
  if (m.type === 'rebuilt' && m.dir === plcDir) {
    const o = $('show').querySelector('option[value="build"]'); if (o && /not built/.test(o.textContent)) vscode.postMessage({ type: 'project', plc: $('plc').value });
    else if ($('show').value === 'build' || $('cmp').value === 'build') req('load');
  }
  if (m.type === 'result') { R = m; render(); }
  if (m.type === 'error') { R = null; $('sum').textContent = ''; $('out').innerHTML = '<div class="err">' + e(m.message) + '</div>'; }
});
$('plc').onchange = () => vscode.postMessage({ type: 'project', plc: $('plc').value });
$('show').onchange = $('cmp').onchange = $('mem').onchange = () => req('load');
$('q').oninput = render;
$('csv').onclick = () => req('export');
$('snap').onclick = () => req('snapshot');
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
