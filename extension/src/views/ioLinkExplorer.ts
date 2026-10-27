// IO-Link explorer: a webview with the IO-Link structure as a collapsible tree (master › port › process data) on
// the left and the details of the selected item on the right, with the independent-project-file actions.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { IoLinkMaster, IoLinkStructure } from '../core/iolinkmasters';

export interface IoLinkSource {
  projects(): { tsproj: string; name: string }[];
  structure(tsproj: string): Promise<IoLinkStructure>;
  readonly onDidChange: vscode.Event<unknown>;
  /** Asks, saves the masters as independent project files and refreshes. */
  saveIndependent(masters: IoLinkMaster[], what: string): Promise<void>;
  reveal(master: IoLinkMaster): Promise<void>;
}

type Msg =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'save'; tsproj: string; path: string }
  | { type: 'saveAll'; tsproj: string }
  | { type: 'reveal'; tsproj: string; path: string };

let panel: vscode.WebviewPanel | undefined;

/** The data the webview shows: per project its masters, with files relative to the project folder. */
export async function explorerData(source: Pick<IoLinkSource, 'projects' | 'structure'>) {
  return Promise.all(source.projects().map(async p => {
    try {
      const s = await source.structure(p.tsproj);
      const dir = path.dirname(p.tsproj);
      return { ...p, warnings: s.warnings, masters: s.masters.map(m => ({ ...m, file: path.relative(dir, m.file).split(path.sep).join('/') })) };
    } catch (e) {
      return { ...p, warnings: [(e as Error).message], masters: [] };
    }
  }));
}

export function showIoLinkExplorer(ctx: vscode.ExtensionContext, source: IoLinkSource, select?: { tsproj: string; path: string }) {
  if (panel) { panel.reveal(); if (select) panel.webview.postMessage({ type: 'select', ...select }); return; }
  panel = vscode.window.createWebviewPanel('iecode.ioLinkExplorer', 'IECode: IO-Link', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);
  const post = (m: unknown) => panel?.webview.postMessage(m);
  const send = async () => post({ type: 'structure', projects: await explorerData(source) });
  const master = async (tsproj: string, p: string) => {
    const m = (await source.structure(tsproj)).masters.find(x => x.path === p);
    if (!m) throw new Error(`${p.split('^').pop()} is no longer in the project; refresh.`);
    return m;
  };

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    try {
      if (m.type === 'ready') { await send(); if (select) post({ type: 'select', ...select }); }
      else if (m.type === 'refresh') await vscode.commands.executeCommand('iecode.ioLinkRefresh');
      else if (m.type === 'reveal') await source.reveal(await master(m.tsproj, m.path));
      else if (m.type === 'save') { const x = await master(m.tsproj, m.path); await source.saveIndependent([x], x.name); }
      else if (m.type === 'saveAll') {
        const ms = (await source.structure(m.tsproj)).masters.filter(x => !x.independent);
        await source.saveIndependent(ms, ms.length === 1 ? ms[0].name : `all ${ms.length} IO-Link masters`);
      }
    } catch (e) {
      post({ type: 'error', message: (e as Error).message });
    }
  }, undefined, ctx.subscriptions);

  const sub = source.onDidChange(() => void send());
  panel.onDidDispose(() => { panel = undefined; sub.dispose(); });
}

export function html(nonce: string, csp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:0;display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit}
#q{flex:1;min-width:160px;max-width:420px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 12px;cursor:pointer;font:inherit;border-radius:2px}
button:hover{background:var(--vscode-button-hoverBackground)}
button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.s:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{opacity:.5;cursor:default}
.sp{flex:1}
.main{flex:1;display:flex;min-height:0}
#tree{width:360px;min-width:200px;max-width:70%;overflow:auto;padding:4px 0;outline:none;border-right:1px solid var(--vscode-panel-border)}
#split{width:4px;cursor:col-resize;margin-left:-2px;z-index:1}
#split:hover,#split.drag{background:var(--vscode-sash-hoverBorder)}
#det{flex:1;overflow:auto;padding:16px 22px}
.row{display:flex;align-items:center;height:22px;padding-right:8px;cursor:pointer;white-space:nowrap}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row.sel{background:var(--vscode-list-inactiveSelectionBackground)}
#tree:focus .row.sel{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);outline:1px solid var(--vscode-list-focusOutline);outline-offset:-1px}
.tw{width:16px;flex:none;text-align:center;opacity:.8;font-size:10px}
.ic{width:16px;height:16px;flex:none;margin-right:6px;display:flex;align-items:center;justify-content:center}
.ic svg{width:14px;height:14px}
.lb{overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:40px}
.ds{margin-left:8px;opacity:.65;font-size:12px;overflow:hidden;text-overflow:ellipsis;flex:1 1 0;min-width:0}
.badge{margin-left:8px;font-size:10px;padding:0 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);flex:none}
.ok{color:var(--vscode-testing-iconPassed,#73c991)}.off{opacity:.45}.lnk{color:var(--vscode-textLink-foreground)}
mark{background:var(--vscode-editor-findMatchHighlightBackground);color:inherit}
h1{font-size:18px;font-weight:600;margin:0 0 2px}
.sub{opacity:.7;margin-bottom:14px}
.crumb{font-size:12px;opacity:.75;margin-bottom:8px}
.crumb a{cursor:pointer;color:var(--vscode-textLink-foreground)}
.acts{display:flex;gap:8px;margin:0 0 18px;flex-wrap:wrap}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:18px}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:10px 12px}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.7;margin:0 0 8px;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
dt{opacity:.7}dd{margin:0;word-break:break-word}
.mono{font-family:var(--vscode-editor-font-family);font-size:12px}
h1.mono{font-size:16px}
h3{font-size:13px;margin:4px 0 8px;display:flex;align-items:center;gap:10px}
h3 label{font-weight:normal;font-size:12px;opacity:.8}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top;word-break:break-word}
th{background:var(--vscode-editor-background);opacity:.85;font-weight:600;position:sticky;top:-16px;white-space:nowrap}
td.t{white-space:nowrap}
tr.click{cursor:pointer}tr.click:hover{background:var(--vscode-list-hoverBackground)}
td.r{text-align:right;white-space:nowrap}
.meter{display:inline-block;width:60px;height:6px;border-radius:3px;background:var(--vscode-panel-border);vertical-align:middle;margin-right:6px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--vscode-textLink-foreground)}
.empty{padding:24px;opacity:.7}.err{color:var(--vscode-errorForeground);padding:6px 12px}
.warn{color:var(--vscode-editorWarning-foreground);font-size:12px;padding:2px 12px}
</style></head><body>
<div class="top">
  <select id="proj" title="System project"></select>
  <input id="q" placeholder="Filter (port, device, variable)">
  <span class="sp"></span>
  <button class="s" id="saveAll" title="Save every IO-Link master still stored inline as its own .xti">Save All Devices as Independent Project Files</button>
  <button class="s" id="ref" title="Reload">Refresh</button>
</div>
<div id="msg"></div>
<div class="main">
  <div id="tree" tabindex="0" role="tree"></div>
  <div id="split"></div>
  <div id="det"><div class="empty">Loading…</div></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (n, d) => '0x' + n.toString(16).toUpperCase().padStart(d, '0');
const ICON = {
  master: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/></svg>',
  port: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5 1.5v3M11 1.5v3"/><path d="M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0z"/><path d="M8 12v2.5"/></svg>',
  empty: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5"><circle cx="8" cy="8" r="5.5"/></svg>',
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/></svg>',
  field: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="5.5" width="10" height="5" rx="1"/></svg>',
};

let projects = [], state = vscode.getState() || {}, rows = [], q = '';
let expanded = new Set(state.expanded || []), selected = state.selected, proj = state.proj;
const save = () => vscode.setState({ expanded: [...expanded], selected, proj });

const project = () => projects.find(p => p.tsproj === proj) || projects[0];
const mid = m => 'm:' + m.path, pid = (m, p) => 'p:' + m.path + '#' + p.number, eid = (m, p, i) => 'e:' + m.path + '#' + p.number + '#' + i;
const linkedCount = p => p.entries.filter(e => e.linked.length).length;

/** Tree nodes of the shown project, with their parent ids. */
function nodes() {
  const out = new Map();
  for (const m of project()?.masters || []) {
    out.set(mid(m), { kind: 'master', id: mid(m), m, kids: m.ports.map(p => pid(m, p)) });
    for (const p of m.ports) {
      out.set(pid(m, p), { kind: 'port', id: pid(m, p), m, p, parent: mid(m), kids: p.entries.map((_, i) => eid(m, p, i)) });
      p.entries.forEach((e, i) => out.set(eid(m, p, i), { kind: 'entry', id: eid(m, p, i), m, p, e, i, parent: pid(m, p), kids: [] }));
    }
  }
  return out;
}
let all = new Map();

const label = n => n.kind === 'master' ? n.m.name : n.kind === 'port' ? 'Port ' + n.p.number + (n.p.name ? ': ' + n.p.name : '') : n.e.name;
const haystack = n => (n.kind === 'master' ? [n.m.name, n.m.type] : n.kind === 'port' ? [label(n), n.p.device?.name, n.p.device?.vendor, n.p.mode] : [n.e.name, n.e.type, ...n.e.linked]).join(' ').toLowerCase();
const hl = s => { if (!q) return esc(s); const i = s.toLowerCase().indexOf(q); return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length)); };

/** With a filter: the ids that match or have a matching descendant. */
function matching() {
  if (!q) return undefined;
  const keep = new Set();
  const visit = id => { const n = all.get(id); let any = haystack(n).includes(q); for (const k of n.kids) if (visit(k)) any = true; if (any) keep.add(id); return any; };
  for (const n of all.values()) if (n.kind === 'master') visit(n.id);
  return keep;
}

function renderTree() {
  const keep = matching();
  rows = [];
  const walk = (id, depth) => {
    const n = all.get(id);
    if (keep && !keep.has(id)) return;
    const open = keep ? n.kids.some(k => keep.has(k)) || expanded.has(id) : expanded.has(id);
    rows.push({ n, depth, open });
    if (open) for (const k of n.kids) walk(k, depth + 1);
  };
  for (const n of all.values()) if (n.kind === 'master') walk(n.id, 0);
  $('tree').innerHTML = rows.length ? rows.map((r, i) => {
    const n = r.n;
    let icon, desc = '', badge = '';
    if (n.kind === 'master') { icon = '<span class="ic">' + ICON.master + '</span>'; desc = n.m.type || ''; if (n.m.independent) badge = '<span class="badge">own file</span>'; }
    else if (n.kind === 'port') { const d = n.p.device; icon = '<span class="ic ' + (d ? 'ok' : 'off') + '">' + (d ? ICON.port : ICON.empty) + '</span>'; desc = d ? d.name || '' : n.p.mode || 'not configured'; badge = n.p.entries.length ? '<span class="badge" title="linked / entries">' + linkedCount(n.p) + '/' + n.p.entries.length + '</span>' : ''; }
    else { icon = '<span class="ic ' + (n.e.linked.length ? 'lnk' : 'off') + '">' + (n.e.linked.length ? ICON.link : ICON.field) + '</span>'; desc = n.e.linked.length ? '⇄ ' + n.e.linked.join(', ') : n.e.type; }
    const tw = n.kids.length ? (r.open ? '▾' : '▸') : '';
    return '<div class="row' + (n.id === selected ? ' sel' : '') + '" role="treeitem" data-i="' + i + '" style="padding-left:' + (6 + r.depth * 14) + 'px">'
      + '<span class="tw">' + tw + '</span>' + icon + '<span class="lb">' + hl(label(n)) + '</span><span class="ds">' + hl(desc) + '</span>' + badge + '</div>';
  }).join('') : '<div class="empty">' + (q ? 'Nothing matches the filter.' : 'No IO-Link masters in this project.') + '</div>';
  $('tree').querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

const kv = rows => '<dl>' + rows.filter(r => r[1] !== undefined && r[1] !== '').map(r => '<dt>' + esc(r[0]) + '</dt><dd' + (r[2] ? ' class="mono"' : '') + '>' + (r[3] ? r[1] : esc(r[1])) + '</dd>').join('') + '</dl>';
const meter = (a, b) => '<span class="meter"><i style="width:' + (b ? Math.round(100 * a / b) : 0) + '%"></i></span>' + a + ' / ' + b;
const crumb = (n) => {
  const parts = n.m.path.split('^').slice(1, -1).map(esc);
  const links = [];
  if (n.kind !== 'master') links.push('<a data-go="' + esc(mid(n.m)) + '">' + esc(n.m.name) + '</a>');
  if (n.kind === 'entry') links.push('<a data-go="' + esc(pid(n.m, n.p)) + '">Port ' + n.p.number + '</a>');
  return '<div class="crumb">' + [...parts, ...links].join(' › ') + '</div>';
};

function renderDetails() {
  const n = all.get(selected);
  const d = $('det');
  if (!n) { d.innerHTML = '<div class="empty">' + (all.size ? 'Select a master, port or process data entry.' : '') + '</div>'; return; }
  if (n.kind === 'master') {
    const m = n.m, used = m.ports.filter(p => p.device).length, entries = m.ports.reduce((s, p) => s + p.entries.length, 0), linked = m.ports.reduce((s, p) => s + linkedCount(p), 0);
    d.innerHTML = crumb(n) + '<h1>' + esc(m.name) + '</h1><div class="sub">' + esc(m.type || 'IO-Link master') + '</div>'
      + '<div class="acts"><button id="aSave"' + (m.independent ? ' disabled title="Already stored in its own file"' : '') + '>Save as Independent Project File</button><button class="s" id="aRev">Reveal in Project File</button></div>'
      + '<div class="cards"><div class="card"><h2>Master</h2>' + kv([['Type', m.type], ['Ports', used + ' of ' + m.ports.length + ' with a device'], ['Process data', meter(linked, entries) + ' linked', false, true]]) + '</div>'
      + '<div class="card"><h2>Storage</h2>' + kv([['File', m.file, true], ['Stored', m.independent ? 'Independent project file' : 'Inline in its parent file']]) + '</div></div>'
      + '<h3>Ports</h3><table><tr><th>Port</th><th>Name</th><th>Device</th><th>Vendor</th><th>Mode</th><th>Linked</th></tr>'
      + m.ports.map(p => '<tr class="click" data-go="' + esc(pid(m, p)) + '"><td>' + p.number + '</td><td>' + esc(p.name || '–') + '</td><td>' + esc(p.device?.name || '–') + '</td><td>' + esc(p.device?.vendor || '') + '</td><td>' + esc(p.mode || '') + '</td><td class="r">' + meter(linkedCount(p), p.entries.length) + '</td></tr>').join('') + '</table>';
    $('aSave').onclick = () => vscode.postMessage({ type: 'save', tsproj: project().tsproj, path: m.path });
    $('aRev').onclick = () => vscode.postMessage({ type: 'reveal', tsproj: project().tsproj, path: m.path });
  } else if (n.kind === 'port') {
    const p = n.p, v = p.device;
    const only = !!state.linkedOnly;
    const list = p.entries.map((e, i) => ({ e, i })).filter(x => !only || x.e.linked.length);
    d.innerHTML = crumb(n) + '<h1>Port ' + p.number + (p.name ? ': ' + esc(p.name) : '') + '</h1><div class="sub">' + esc(v ? [v.name, v.vendor].filter(Boolean).join(' · ') : 'No device configured') + '</div>'
      + '<div class="cards"><div class="card"><h2>Device</h2>' + (v ? kv([['Vendor', v.vendor], ['Device', v.name], ['Family', v.family], ['Description', v.text],
          ['Vendor ID', v.vendorId !== undefined ? v.vendorId + ' (' + hex(v.vendorId, 4) + ')' : undefined, true], ['Device ID', v.deviceId !== undefined ? v.deviceId + ' (' + hex(v.deviceId, 6) + ')' : undefined, true], ['IODD', v.iodd, true]]) : '<div class="off">–</div>') + '</div>'
      + '<div class="card"><h2>Port</h2>' + kv([['Mode', p.mode || 'not configured'], ['PDO', p.pdo], ['Process data', meter(linkedCount(p), p.entries.length) + ' linked', false, true]]) + '</div></div>'
      + (p.entries.length ? '<h3>Process data <label><input type="checkbox" id="only"' + (only ? ' checked' : '') + '> linked only</label></h3><table><tr><th>Name</th><th>Type</th><th>Bits</th><th>Linked to</th></tr>'
        + list.map(x => '<tr class="click" data-go="' + esc(eid(n.m, p, x.i)) + '"><td class="mono">' + hl(x.e.name) + '</td><td class="t">' + esc(x.e.type) + '</td><td class="r">' + (x.e.bitLen ?? '') + '</td><td class="mono">' + (x.e.linked.length ? x.e.linked.map(hl).join('<br>') : '<span class="off">–</span>') + '</td></tr>').join('') + '</table>' : '');
    const o = $('only'); if (o) o.onchange = () => { state.linkedOnly = o.checked; vscode.setState({ ...vscode.getState(), linkedOnly: o.checked }); renderDetails(); };
  } else {
    const e = n.e;
    d.innerHTML = crumb(n) + '<h1 class="mono">' + esc(e.name) + '</h1><div class="sub">' + esc(e.type) + (e.bitLen ? ' · ' + e.bitLen + ' bit' : '') + '</div>'
      + '<div class="cards"><div class="card"><h2>Process data entry</h2>' + kv([['Type', e.type], ['Bit length', e.bitLen], ['PDO', n.p.pdo], ['Port', 'Port ' + n.p.number + (n.p.name ? ': ' + n.p.name : '')], ['Master', n.m.name]]) + '</div>'
      + '<div class="card"><h2>Linked to</h2>' + (e.linked.length ? e.linked.map(l => '<div class="mono">' + esc(l) + '</div>').join('') : '<div class="off">Not linked</div>') + '</div></div>';
  }
  d.querySelectorAll('[data-go]').forEach(el => el.onclick = () => { const id = el.getAttribute('data-go'); for (let a = all.get(id)?.parent; a; a = all.get(a)?.parent) expanded.add(a); choose(id); });
}

function choose(id) { selected = id; save(); renderTree(); renderDetails(); }
function toggle(n, open) { if (!n.kids.length) return; if (open ?? !expanded.has(n.id)) expanded.add(n.id); else expanded.delete(n.id); save(); renderTree(); }

$('tree').onclick = ev => {
  const el = ev.target.closest('.row'); if (!el) return;
  const r = rows[+el.dataset.i];
  if (ev.target.closest('.tw') || r.n.id === selected) toggle(r.n); else choose(r.n.id);
};
$('tree').ondblclick = ev => { const el = ev.target.closest('.row'); if (el && !ev.target.closest('.tw')) toggle(rows[+el.dataset.i].n); };
$('tree').onkeydown = ev => {
  const i = rows.findIndex(r => r.n.id === selected);
  const r = rows[i];
  if (ev.key === 'ArrowDown') { const x = rows[Math.min(rows.length - 1, i + 1)]; if (x) choose(x.n.id); }
  else if (ev.key === 'ArrowUp') { const x = rows[Math.max(0, i - 1)]; if (x) choose(x.n.id); }
  else if (ev.key === 'ArrowRight' && r) { if (r.n.kids.length && !r.open) toggle(r.n, true); else if (r.open) choose(r.n.kids[0]); }
  else if (ev.key === 'ArrowLeft' && r) { if (r.open) toggle(r.n, false); else if (r.n.parent) choose(r.n.parent); }
  else if ((ev.key === 'Enter' || ev.key === ' ') && r) toggle(r.n);
  else return;
  ev.preventDefault();
};

// Splitter between tree and details.
$('split').onmousedown = ev => {
  ev.preventDefault();
  const tree = $('tree'), start = ev.clientX, w = tree.offsetWidth;
  $('split').classList.add('drag');
  const move = e => { tree.style.width = Math.max(200, w + e.clientX - start) + 'px'; };
  const up = () => { $('split').classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
};

$('q').oninput = () => { q = $('q').value.trim().toLowerCase(); renderTree(); renderDetails(); };
$('proj').onchange = () => { proj = $('proj').value; selected = undefined; save(); show(); };
$('saveAll').onclick = () => vscode.postMessage({ type: 'saveAll', tsproj: project().tsproj });
$('ref').onclick = () => vscode.postMessage({ type: 'refresh' });

function show() {
  all = nodes();
  const p = project();
  if (!all.has(selected)) {
    const first = [...all.values()][0];
    selected = first?.id;
    if (first) expanded.add(first.id);
  }
  $('proj').style.display = projects.length > 1 ? '' : 'none';
  $('proj').innerHTML = projects.map(x => '<option value="' + esc(x.tsproj) + '"' + (x === p ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
  $('saveAll').disabled = !p || !p.masters.some(m => !m.independent);
  $('msg').innerHTML = (p?.warnings || []).map(w => '<div class="warn">⚠ ' + esc(w) + '</div>').join('');
  save(); renderTree(); renderDetails();
}

addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'structure') { projects = m.projects; if (!projects.some(p => p.tsproj === proj)) proj = projects[0]?.tsproj; if (!projects.length) { $('tree').innerHTML = ''; $('det').innerHTML = '<div class="empty">No TwinCAT system project in this workspace.</div>'; return; } show(); }
  else if (m.type === 'select') { proj = m.tsproj; projects.length && show(); const id = 'm:' + m.path; if (all.has(id)) { expanded.add(id); choose(id); } }
  else if (m.type === 'error') { $('msg').innerHTML = '<div class="err">' + esc(m.message) + '</div>'; }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
