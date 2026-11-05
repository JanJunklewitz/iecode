// Page of the "Config Changes" panel. No vscode import, so node --test can load it.

import { CATEGORIES, NOISE } from '../core/configmodel';

const box = (id: string) => `<label class="f"><input type="checkbox" data-filter="${id}" checked> ${id}<span class="c" data-count="${id}"></span></label>`;

export function html(nonce: string, csp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:0}
.top{padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
.row1,.row2{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row2{margin-top:8px}
select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit;max-width:340px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:4px 12px;cursor:pointer;font:inherit}
label{font-size:12px;opacity:.85}.f{white-space:nowrap}.c{opacity:.6;margin-left:3px}.sep{opacity:.4}
.sum{padding:8px 14px;opacity:.85;font-size:12px}
.warn{padding:0 14px 6px;color:var(--vscode-editorWarning-foreground);font-size:12px}
#out{padding:4px 14px 14px;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size,13px)}
summary{cursor:pointer;padding:2px 0;white-space:nowrap}
.n{opacity:.55;font-size:11px;margin-left:6px}
.r{margin-left:22px;padding:1px 0;display:flex;gap:10px;align-items:baseline}
.kind{min-width:60px;font-size:11px;opacity:.85}
.added .kind{color:var(--vscode-gitDecoration-addedResourceForeground)}
.removed .kind{color:var(--vscode-gitDecoration-deletedResourceForeground)}
.changed .kind{color:var(--vscode-gitDecoration-modifiedResourceForeground)}
.k{word-break:break-all}.v{opacity:.85;word-break:break-word}
.old{color:var(--vscode-gitDecoration-deletedResourceForeground);text-decoration:line-through}
.new{color:var(--vscode-gitDecoration-addedResourceForeground)}
.more{margin-left:22px;opacity:.65;font-style:italic}
.err{color:var(--vscode-errorForeground);padding:14px}.empty{padding:14px;opacity:.7}
a{color:var(--vscode-textLink-foreground)}
</style></head><body>
<div class="top">
  <div class="row1">
    <b id="file"></b>
    <label>Compare</label><select id="left"></select><label>with</label><select id="right"></select>
    <button id="yaml" title="Open both versions as YAML in the diff editor">Open as YAML</button>
    <button id="raw" title="Open both versions as raw XML in the diff editor, with all changes and no filters">Open Raw XML</button>
    <button id="toggle">Expand / Collapse</button>
  </div>
  <div class="row2"><label>show:</label>
    ${CATEGORIES.map(box).join('')}<span class="sep">|</span>${NOISE.map(box).join('')}
  </div>
</div>
<div class="sum" id="sum"></div>
<div class="warn" id="warn"></div>
<div id="out"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let file = '';
function req(type) {
  vscode.postMessage({ type, file, left: $('left').value, right: $('right').value,
    leftLabel: $('left').selectedOptions[0]?.text ?? '', rightLabel: $('right').selectedOptions[0]?.text ?? '' });
}
function boxes(hidden, by) {
  document.querySelectorAll('[data-filter]').forEach(b => {
    const id = b.dataset.filter;
    b.checked = !hidden.includes(id);
    const n = by[id];
    document.querySelector('[data-count="' + id + '"]').textContent = n && !b.checked ? '(' + n + ' hidden)' : '';
  });
}
function render(m) {
  boxes(m.hidden, m.hiddenBy);
  $('sum').innerHTML = m.visible + ' visible change(s) · ' + m.hiddenTotal + ' hidden · '
    + (m.links ? '<a href="#" id="iol">' + m.links + ' IO link change(s)</a>' : '0 IO link change(s)');
  $('warn').textContent = m.warnings.join(' · ');
  const groups = m.groups.filter(g => g.total);
  $('out').innerHTML = groups.length ? groups.map(g => '<details open><summary>' + e(g.category) + ' · ' + g.total + ' change' + (g.total === 1 ? '' : 's')
    + (g.hidden ? ' (' + g.hidden + ' hidden)' : '') + '</summary>'
    + g.shown.map(c => '<div class="r ' + c.kind + '"><span class="kind">' + c.kind + '</span><span class="k">' + e(c.key) + '</span><span class="v">'
      + (c.kind === 'changed' ? '<span class="old">' + e(c.before) + '</span> → <span class="new">' + e(c.after) + '</span>' : c.kind === 'added' ? '<span class="new">' + e(c.after) + '</span>' : '<span class="old">' + e(c.before) + '</span>') + '</span></div>').join('')
    + (g.total > g.shown.length ? '<div class="more">… and ' + (g.total - g.shown.length) + ' more (open as YAML to see all)</div>' : '')
    + '</details>').join('') : '<div class="empty">No visible differences.</div>';
}
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'init') {
    file = m.file; $('file').textContent = m.name;
    const opts = m.versions.map(v => '<option value="' + e(v.ref) + '">' + e(v.label) + '</option>').join('');
    $('left').innerHTML = opts; $('right').innerHTML = opts;
    $('left').value = m.left; $('right').value = m.right;
    boxes(m.hidden, {});
    req('load');
  }
  if (m.type === 'result') render(m);
  if (m.type === 'error') $('out').innerHTML = '<div class="err">' + e(m.message) + '</div>';
});
document.addEventListener('click', ev => { if (ev.target.id === 'iol') { ev.preventDefault(); vscode.postMessage({ type: 'ioLinks', file }); } });
document.querySelectorAll('[data-filter]').forEach(b => b.onchange = () =>
  vscode.postMessage({ type: 'filter', hidden: [...document.querySelectorAll('[data-filter]')].filter(x => !x.checked).map(x => x.dataset.filter) }));
$('left').onchange = $('right').onchange = () => req('load');
$('yaml').onclick = () => req('yaml');
$('raw').onclick = () => req('raw');
$('toggle').onclick = () => { const d = [...document.querySelectorAll('#out details')]; const open = d.some(x => !x.open); d.forEach(x => x.open = open); };
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
