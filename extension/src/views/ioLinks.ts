// IO links view: lists the links of a TwinCAT project and compares them between two versions
// (working copy, HEAD or any commit that touched the project).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { WorkspaceState } from '../state';
import { changesToCsv, diffLinks, linksToCsv } from '../core/iolinks';
import { linksAt } from '../core/iohistory';
import { log, repoRoot } from '../core/git';

type Msg =
  | { type: 'ready' }
  | { type: 'project'; tsproj: string }
  | { type: 'load'; tsproj: string; left: string; right: string }
  | { type: 'export'; tsproj: string; left: string; right: string };

const WORKING = '';               // ref value for the working copy

let panel: vscode.WebviewPanel | undefined;

/** Project name, with its workspace-relative path when another project has the same name (e.g. a copy of the solution). */
function projectLabel(file: string, all: string[]): string {
  const name = path.basename(file, '.tsproj');
  return all.filter(f => path.basename(f, '.tsproj') === name).length > 1 ? `${name} (${vscode.workspace.asRelativePath(file)})` : name;
}

/** TwinCAT system projects (.tsproj) in the workspace. */
function projects(state: WorkspaceState): string[] {
  return [...new Set(state.current.solutions.flatMap(s => s.projects.filter(p => !p.plcOnly).map(p => p.file)))].sort();
}

export function showIoLinks(ctx: vscode.ExtensionContext, state: WorkspaceState, tsproj?: string) {
  if (panel) { panel.reveal(); if (tsproj) panel.webview.postMessage({ type: 'select', tsproj }); return; }
  panel = vscode.window.createWebviewPanel('iecode.ioLinks', 'IECode: IO Links', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);
  const post = (m: unknown) => panel?.webview.postMessage(m);

  const versions = async (file: string) => {
    const root = await repoRoot(file);
    const commits = root ? await log(root, [path.dirname(file)], 100) : [];
    return [{ ref: WORKING, label: 'Working copy' }, ...(root ? [{ ref: 'HEAD', label: 'HEAD' }] : []),
      ...commits.map(c => ({ ref: c.hash, label: `${c.short} · ${c.date} · ${c.subject}` }))];
  };

  const compute = async (m: { tsproj: string; left: string; right: string }) => {
    const ref = (r: string) => (r === WORKING ? undefined : r);
    if (m.left === m.right) return { mode: 'list' as const, links: await linksAt(m.tsproj, ref(m.right)) };
    const [before, after] = await Promise.all([linksAt(m.tsproj, ref(m.left)), linksAt(m.tsproj, ref(m.right))]);
    return { mode: 'diff' as const, changes: diffLinks(before, after), before: before.length, after: after.length };
  };

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    try {
      if (m.type === 'ready') {
        const list = projects(state);
        const first = tsproj && list.includes(tsproj) ? tsproj : list[0];
        post({ type: 'projects', projects: list.map(f => ({ file: f, name: projectLabel(f, list) })), selected: first });
        if (first) post({ type: 'versions', tsproj: first, versions: await versions(first) });
      } else if (m.type === 'project') {
        post({ type: 'versions', tsproj: m.tsproj, versions: await versions(m.tsproj) });
      } else if (m.type === 'load') {
        post({ type: 'result', ...(await compute(m)) });
      } else if (m.type === 'export') {
        const r = await compute(m);
        const name = path.basename(m.tsproj, '.tsproj') + (r.mode === 'list' ? '-io-links.csv' : '-io-link-changes.csv');
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(m.tsproj), name)), filters: { CSV: ['csv'] } });
        if (!target) return;
        await fs.writeFile(target.fsPath, '﻿' + (r.mode === 'list' ? linksToCsv(r.links) : changesToCsv(r.changes)), 'utf8');
        vscode.window.showInformationMessage(`IECode: saved ${path.basename(target.fsPath)}`);
      }
    } catch (e) {
      post({ type: 'error', message: (e as Error).message });
    }
  }, undefined, ctx.subscriptions);

  panel.onDidDispose(() => { panel = undefined; });
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
.sum{padding:8px 14px;opacity:.8;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top;word-break:break-word}
th{position:sticky;top:0;background:var(--vscode-editor-background);opacity:.85;font-weight:600}
.k{font-weight:600;white-space:nowrap}.added{color:var(--vscode-gitDecoration-addedResourceForeground)}
.removed{color:var(--vscode-gitDecoration-deletedResourceForeground)}.moved,.changed{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.dim{opacity:.6}.err{color:var(--vscode-errorForeground);padding:14px}.empty{padding:14px;opacity:.7}
label{font-size:12px;opacity:.8}
</style></head><body>
<div class="top">
  <label>Project</label><select id="proj"></select>
  <label>Compare</label><select id="left"></select><label>with</label><select id="right"></select>
  <input id="q" placeholder="Filter (variable, terminal, channel)">
  <label><input type="checkbox" id="full"> full paths</label>
  <button class="s" id="csv">Export CSV</button>
</div>
<div class="sum" id="sum"></div>
<div id="out"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let R = null;
// variables: task + name (e.g. PlcTask Inputs^MAIN.bStart); IO: terminal + channel (e.g. Term 2 (EL1008)^Channel 1^Input)
const cut = (p, n) => { if ($('full').checked || !p) return p ?? ''; const x = p.split('^'); return x.length <= n ? p : '…^' + x.slice(-n).join('^'); };
const sv = p => cut(p, 2), si = p => cut(p, 3);
function req(type) { const m = { type, tsproj: $('proj').value, left: $('left').value, right: $('right').value }; if (m.tsproj) vscode.postMessage(m); }
function render() {
  if (!R) return;
  const q = $('q').value.toLowerCase();
  const hit = (...xs) => !q || xs.some(x => (x ?? '').toLowerCase().includes(q));
  if (R.mode === 'list') {
    const rows = R.links.filter(l => hit(l.variable, l.io));
    $('sum').textContent = rows.length + ' of ' + R.links.length + ' link(s)';
    $('out').innerHTML = rows.length ? '<table><tr><th>Variable</th><th>IO</th><th>Attributes</th><th>File</th></tr>' + rows.map(l =>
      '<tr><td>' + e(sv(l.variable)) + '</td><td>' + e(si(l.io)) + '</td><td class="dim">' + e(Object.entries(l.attrs).map(([k,v]) => k + '=' + v).join(' ')) + '</td><td class="dim">' + e(l.file) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">No IO links in this version.</div>';
  } else {
    const rows = R.changes.filter(c => hit(c.variable, c.before, c.after));
    const n = k => R.changes.filter(c => c.kind === k).length;
    $('sum').textContent = R.before + ' → ' + R.after + ' link(s) · ' + n('added') + ' added · ' + n('removed') + ' removed · ' + n('moved') + ' moved · ' + n('changed') + ' changed';
    $('out').innerHTML = rows.length ? '<table><tr><th></th><th>Variable</th><th>Before</th><th>After</th></tr>' + rows.map(c =>
      '<tr><td class="k ' + c.kind + '">' + c.kind + '</td><td>' + e(sv(c.variable)) + '</td><td>' + e(si(c.before)) + '</td><td>' + e(c.kind === 'changed' ? c.details : si(c.after)) + '</td></tr>').join('') + '</table>'
      : '<div class="empty">' + (R.changes.length ? 'No change matches the filter.' : 'No differences in the IO links.') + '</div>';
  }
}
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'projects') {
    $('proj').innerHTML = m.projects.length ? m.projects.map(p => '<option value="' + e(p.file) + '">' + e(p.name) + '</option>').join('') : '<option value="">(no TwinCAT project)</option>';
    if (m.selected) $('proj').value = m.selected;
    if (!m.projects.length) $('out').innerHTML = '<div class="empty">No TwinCAT system project (.tsproj) in this workspace.</div>';
  }
  if (m.type === 'select') { $('proj').value = m.tsproj; vscode.postMessage({ type: 'project', tsproj: m.tsproj }); }
  if (m.type === 'versions') {
    const opts = m.versions.map(v => '<option value="' + e(v.ref) + '">' + e(v.label) + '</option>').join('');
    $('left').innerHTML = opts; $('right').innerHTML = opts;
    $('left').value = m.versions.length > 1 ? m.versions[1].ref : ''; $('right').value = '';
    req('load');
  }
  if (m.type === 'result') { R = m; render(); }
  if (m.type === 'error') $('out').innerHTML = '<div class="err">' + e(m.message) + '</div>';
});
$('proj').onchange = () => vscode.postMessage({ type: 'project', tsproj: $('proj').value });
$('left').onchange = $('right').onchange = () => req('load');
$('q').oninput = render; $('full').onchange = render;
$('csv').onclick = () => req('export');
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
