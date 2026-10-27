// IO links view: shows the links of a TwinCAT project as a hardware tree (device > box > terminal > channel)
// and compares them between two versions (working copy, HEAD or any commit that touched the project).
// Both versions can also be opened as YAML in VS Code's diff editor (also from the context menu of a .tsproj / .xti).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { WorkspaceState } from '../state';
import { changesToCsv, diffLinks, linksToCsv, sortLinks, toIoLink } from '../core/iolinks';
import { buildTree, diffSummary, diffTrees, treeToYaml } from '../core/iotree';
import { projectAt } from '../core/iohistory';
import { log, repoRoot } from '../core/git';

type Msg =
  | { type: 'ready' }
  | { type: 'project'; tsproj: string }
  | { type: 'load'; tsproj: string; left: string; right: string }
  | { type: 'export'; tsproj: string; left: string; right: string }
  | { type: 'yaml'; tsproj: string; left: string; right: string; leftLabel: string; rightLabel: string };

const WORKING = '';               // ref value for the working copy
export const YAML_SCHEME = 'iecode-io';

let panel: vscode.WebviewPanel | undefined;

/** iecode-io:/<project> IO links (<label>).yaml?tsproj=…&ref=… shows the links of one version as YAML. */
const yamlUri = (tsproj: string, ref: string, label: string) => vscode.Uri.from({
  scheme: YAML_SCHEME, path: `/${path.basename(tsproj, '.tsproj')} IO links (${label.replace(/[\\/]/g, '_')}).yaml`,
  query: new URLSearchParams({ tsproj, ref, label }).toString(),
});

async function openYamlDiff(tsproj: string, left: string, right: string, leftLabel: string, rightLabel: string) {
  const name = path.basename(tsproj, '.tsproj');
  if (left === right) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(yamlUri(tsproj, right, rightLabel)), { preview: false });
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', yamlUri(tsproj, left, leftLabel), yamlUri(tsproj, right, rightLabel),
    `${name} IO links: ${leftLabel} ↔ ${rightLabel}`, { preview: false });
}

/** The .tsproj a file belongs to: itself, or the nearest .tsproj in a folder above it (for an .xti). */
export async function owningProject(file: string): Promise<string | undefined> {
  if (/\.tsproj$/i.test(file)) return file;
  const stop = await repoRoot(path.dirname(file));
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const found = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => /\.tsproj$/i.test(f)).sort();
    if (found.length) return path.join(dir, found[0]);
    if (dir === stop || path.dirname(dir) === dir) return undefined;
  }
}

/** YAML documents and the "Compare IO Links with HEAD" command of the explorer / editor / Source Control menus. */
export function registerIoYaml(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(YAML_SCHEME, {
    async provideTextDocumentContent(uri) {
      const q = new URLSearchParams(uri.query);
      const tsproj = q.get('tsproj') ?? '', ref = q.get('ref') ?? '';
      try {
        const s = await projectAt(tsproj, ref === WORKING ? undefined : ref);
        const header = `# IO links of ${path.basename(tsproj)} (${q.get('label')}): ${s.links.length} link(s)`
          + s.warnings.map(w => `\n# warning: ${w}`).join('');
        return treeToYaml(buildTree(s.links, s.boxes), header);
      } catch (e) {
        return `# ${(e as Error).message}\n`;
      }
    },
  }));

  // explorer / editor title: a Uri; Source Control: a resource state with resourceUri
  const yamlCommand = (id: string, fn: (tsproj: string, root: string | undefined) => Promise<unknown>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri } | undefined)?.resourceUri
        ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file' || !/\.(tsproj|xti)$/i.test(uri.fsPath)) {
        vscode.window.showInformationMessage('IECode: select a .tsproj or .xti file to compare its IO links.');
        return;
      }
      try {
        const tsproj = await owningProject(uri.fsPath);
        if (!tsproj) { vscode.window.showWarningMessage('IECode: no TwinCAT system project (.tsproj) found for this file.'); return; }
        await fn(tsproj, await repoRoot(tsproj));
      } catch (e) {
        vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
      }
    }));

  yamlCommand('iecode.ioLinksDiff', (tsproj, root) =>
    openYamlDiff(tsproj, root ? 'HEAD' : WORKING, WORKING, root ? 'HEAD' : 'working copy', 'working copy'));

  yamlCommand('iecode.ioLinksDiffCommit', async (tsproj, root) => {
    if (!root) { vscode.window.showWarningMessage('IECode: this project is not in a git repository.'); return; }
    const commits = await log(root, [path.dirname(tsproj)], 100);
    const pick = await vscode.window.showQuickPick(
      commits.map(c => ({ label: `$(git-commit) ${c.short}  ${c.subject}`, description: `${c.date} · ${c.author}`, c })),
      { title: `Compare the IO links of ${path.basename(tsproj)} with …`, matchOnDescription: true });
    if (pick) await openYamlDiff(tsproj, pick.c.hash, WORKING, pick.c.short, 'working copy');
  });
}

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

  const ref = (r: string) => (r === WORKING ? undefined : r);
  const compute = async (m: { tsproj: string; left: string; right: string }) => {
    if (m.left === m.right) {
      const s = await projectAt(m.tsproj, ref(m.right));
      const tree = buildTree(s.links, s.boxes);
      return { mode: 'list' as const, tree: diffTrees(tree, tree), count: s.links.length, warnings: s.warnings };
    }
    const [a, b] = await Promise.all([projectAt(m.tsproj, ref(m.left)), projectAt(m.tsproj, ref(m.right))]);
    const tree = diffTrees(buildTree(a.links, a.boxes), buildTree(b.links, b.boxes));
    return { mode: 'diff' as const, tree, summary: diffSummary(tree), before: a.links.length, after: b.links.length, warnings: [...new Set([...a.warnings, ...b.warnings])] };
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
      } else if (m.type === 'yaml') {
        const short = (r: string, label: string) => (r === WORKING || r === 'HEAD' ? label : label.split(' · ')[0]);
        await openYamlDiff(m.tsproj, m.left, m.right, short(m.left, m.leftLabel), short(m.right, m.rightLabel));
      } else if (m.type === 'export') {
        const [a, b] = await Promise.all([projectAt(m.tsproj, ref(m.left)), m.left === m.right ? undefined : projectAt(m.tsproj, ref(m.right))]);
        const list = !b;
        const name = path.basename(m.tsproj, '.tsproj') + (list ? '-io-links.csv' : '-io-link-changes.csv');
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(m.tsproj), name)), filters: { CSV: ['csv'] } });
        if (!target) return;
        const links = (s: typeof a) => sortLinks(s.links.map(toIoLink));
        await fs.writeFile(target.fsPath, '﻿' + (b ? changesToCsv(diffLinks(links(a), links(b))) : linksToCsv(links(a))), 'utf8');
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
.top{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap;position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit;max-width:340px}
#q{flex:1;min-width:140px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 12px;cursor:pointer;font:inherit}
button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.sum{padding:8px 14px;opacity:.8;font-size:12px}
.warn{padding:0 14px 6px;color:var(--vscode-editorWarning-foreground);font-size:12px}
#out{padding:4px 14px 14px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size,13px)}
details{margin-left:14px}#out>details{margin-left:0}
summary{cursor:pointer;padding:1px 0;white-space:nowrap}
summary .n{opacity:.55;font-size:11px;margin-left:6px}
.leaf{margin-left:28px;padding:1px 0;display:flex;gap:6px;align-items:baseline}
#out>.leaf{margin-left:14px}
.leaf .k{white-space:nowrap}.leaf .k::after{content:':';opacity:.6}
.vals{display:flex;flex-direction:column;word-break:break-word}
.v.removed{color:var(--vscode-gitDecoration-deletedResourceForeground);text-decoration:line-through}
.v.added{color:var(--vscode-gitDecoration-addedResourceForeground)}
.mv{opacity:.7;font-size:11px;margin-left:6px;text-decoration:none;display:inline-block}
.added>summary,.leaf.added>.k{color:var(--vscode-gitDecoration-addedResourceForeground)}
.removed>summary,.leaf.removed>.k{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.changed>summary,.leaf.changed>.k{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.badge{font-size:10px;padding:0 5px;border-radius:8px;margin-left:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.err{color:var(--vscode-errorForeground);padding:14px}.empty{padding:14px;opacity:.7}
label{font-size:12px;opacity:.8}
mark{background:var(--vscode-editor-findMatchHighlightBackground);color:inherit}
</style></head><body>
<div class="top">
  <label>Project</label><select id="proj"></select>
  <label>Compare</label><select id="left"></select><label>with</label><select id="right"></select>
  <input id="q" placeholder="Filter (device, terminal, channel, variable)">
  <label id="onlyL"><input type="checkbox" id="only" checked> only changes</label>
  <button class="s" id="exp" title="Expand all">+</button><button class="s" id="col" title="Collapse all">−</button>
  <button class="s" id="yaml" title="Open both versions as YAML in the diff editor">Open as YAML</button>
  <button class="s" id="csv">Export CSV</button>
</div>
<div class="sum" id="sum"></div>
<div class="warn" id="warn"></div>
<div id="out"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let R = null;
const closed = new Set();   // paths of nodes the user collapsed (everything is expanded by default, like the YAML)
function req(type) {
  const m = { type, tsproj: $('proj').value, left: $('left').value, right: $('right').value,
    leftLabel: $('left').selectedOptions[0]?.text ?? '', rightLabel: $('right').selectedOptions[0]?.text ?? '' };
  if (m.tsproj) vscode.postMessage(m);
}
const hl = (s, q) => { if (!q) return e(s); const i = s.toLowerCase().indexOf(q); return i < 0 ? e(s) : e(s.slice(0, i)) + '<mark>' + e(s.slice(i, i + q.length)) + '</mark>' + e(s.slice(i + q.length)); };
function leaves(x) { return x.kids ? x.kids.reduce((n, k) => n + leaves(k), 0) : 1; }
// filters the tree: a node stays when its key matches (with everything below) or something below it matches
function filter(list, q, only, path) {
  const out = [];
  for (const x of list) {
    if (only && x.state === 'same') continue;
    const p = path ? path + ' › ' + x.key : x.key;
    const self = !q || x.key.toLowerCase().includes(q);
    if (x.kids) {
      const kids = filter(x.kids, self ? '' : q, only, p);
      if (kids.length) out.push({ ...x, kids, p });
    } else if (self || x.values.some(v => v.text.toLowerCase().includes(q))) out.push({ ...x, p });
  }
  return out;
}
function node(x, q, diff) {
  if (x.kids) {
    const badge = diff && x.state !== 'same' ? '<span class="badge">' + x.state + '</span>' : '';
    return '<details class="' + (diff ? x.state : '') + '" data-p="' + e(x.p) + '"' + (closed.has(x.p) ? '' : ' open') + '><summary>' + hl(x.key, q) + '<span class="n">' + leaves(x) + '</span>' + badge + '</summary>'
      + x.kids.map(k => node(k, q, diff)).join('') + '</details>';
  }
  const vals = x.values.map(v => '<span class="v ' + (diff ? v.state : '') + '" title="' + e(v.text) + '">' + hl(v.text, q)
    + (v.moved ? '<span class="mv">' + (v.state === 'added' ? '← from ' : '→ to ') + e(v.moved) + '</span>' : '') + '</span>').join('');
  return '<div class="leaf ' + (diff ? x.state : '') + '"><span class="k">' + hl(x.key, q) + '</span><span class="vals">' + vals + '</span></div>';
}
function render() {
  if (!R) return;
  const q = $('q').value.trim().toLowerCase();
  const diff = R.mode === 'diff';
  $('onlyL').style.display = diff ? '' : 'none';
  const rows = filter(R.tree, q, diff && $('only').checked, '');
  if (diff) {
    const s = R.summary;
    $('sum').textContent = R.before + ' → ' + R.after + ' link(s) · ' + s.channels + ' channel(s) changed · ' + s.added + ' added · ' + s.removed + ' removed · ' + s.moved + ' moved';
  } else $('sum').textContent = R.count + ' link(s)';
  $('warn').textContent = (R.warnings || []).join(' · ');
  $('out').innerHTML = rows.length ? rows.map(x => node(x, q, diff)).join('')
    : '<div class="empty">' + (diff && !R.tree.some(x => x.state !== 'same') ? 'No differences in the IO links.' : R.tree.length ? 'Nothing matches the filter.' : 'No IO links in this version.') + '</div>';
}
$('out').addEventListener('toggle', ev => {
  const d = ev.target; if (!d.dataset || !d.dataset.p) return;
  if (d.open) closed.delete(d.dataset.p); else closed.add(d.dataset.p);
}, true);
function all(state) { document.querySelectorAll('#out details').forEach(d => d.open = state); }
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
$('q').oninput = render; $('only').onchange = render;
$('exp').onclick = () => all(true); $('col').onclick = () => all(false);
$('yaml').onclick = () => req('yaml');
$('csv').onclick = () => req('export');
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
