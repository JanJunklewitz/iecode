// Settings panel: all iecode.* settings in three groups (General, IO-Link, ADS Watch), opened from the "..." menu of the
// ADS Watch view. The fields come from package.json (core/configFields.ts); saving writes where the value comes from.

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ConfigField, GROUPS, configFields, parseInput, toInputText } from '../core/configFields';

type Msg = { type: 'ready' } | { type: 'save'; values: Record<string, unknown> } | { type: 'openJson' };

let panel: vscode.WebviewPanel | undefined;

function fieldsOf(ctx: vscode.ExtensionContext): ConfigField[] {
  const props = ctx.extension.packageJSON?.contributes?.configuration?.properties ?? {};
  return configFields(props);
}

/** The value the user sees: user-only settings from the user settings, the others as VS Code resolves them. */
function currentText(f: ConfigField): string {
  const i = vscode.workspace.getConfiguration().inspect<unknown>(f.key);
  const v = f.userOnly ? (i?.globalValue ?? i?.defaultValue) : (vscode.workspace.getConfiguration().get<unknown>(f.key) ?? i?.defaultValue);
  return toInputText(f, v);
}

/** A workspace value would win over the user value for a normal setting, so it is written where it comes from. */
function targetOf(f: ConfigField): vscode.ConfigurationTarget {
  if (f.userOnly) return vscode.ConfigurationTarget.Global;
  const i = vscode.workspace.getConfiguration().inspect<unknown>(f.key);
  return i?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

export function showConfigPanel(ctx: vscode.ExtensionContext) {
  if (panel) { panel.reveal(); return; }
  const fields = fieldsOf(ctx);
  panel = vscode.window.createWebviewPanel('iecode.config', 'IECode: Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const p = panel;
  const nonce = randomBytes(16).toString('hex');
  p.webview.html = html(nonce, p.webview.cspSource, fields);
  const send = (extra: Record<string, unknown> = {}) =>
    p.webview.postMessage({ type: 'values', values: Object.fromEntries(fields.map(f => [f.key, currentText(f)])), ...extra });

  const subs = [
    p.webview.onDidReceiveMessage(async (m: Msg) => {
      if (m.type === 'ready') return send();
      if (m.type === 'openJson') return vscode.commands.executeCommand('workbench.action.openSettingsJson');
      if (m.type !== 'save') return;
      // validate everything first, write nothing when one value is wrong
      const parsed: { f: ConfigField; value: unknown }[] = [];
      for (const [key, raw] of Object.entries(m.values)) {
        const f = fields.find(x => x.key === key);
        if (!f) continue;
        const r = parseInput(f, raw);
        if ('problem' in r) return p.webview.postMessage({ type: 'error', message: r.problem });
        parsed.push({ f, value: r.value });
      }
      try {
        for (const { f, value } of parsed) {
          const same = JSON.stringify(value) === JSON.stringify(f.def);
          await vscode.workspace.getConfiguration().update(f.key, same ? undefined : value, targetOf(f));   // the default is stored as "not set"
        }
        void send({ saved: parsed.length });
      } catch (e) {
        void p.webview.postMessage({ type: 'error', message: `Not saved: ${(e as Error).message}` });
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode') && p.visible) void send(); }),
  ];
  p.onDidDispose(() => { panel = undefined; subs.forEach(s => s.dispose()); });
}

function html(nonce: string, csp: string, fields: ConfigField[]): string {
  const data = JSON.stringify({ fields, groups: GROUPS }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:16px 20px;max-width:820px}
h2{font-size:15px;margin:0 0 10px}h3{font-size:13px;margin:22px 0 4px;padding-bottom:3px;border-bottom:1px solid var(--vscode-panel-border);text-transform:uppercase;letter-spacing:.04em;opacity:.8}
a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}
.row{display:grid;grid-template-columns:200px 1fr;gap:4px 12px;align-items:start;padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}
.row label{padding-top:4px;word-break:break-word}.hint{grid-column:2;font-size:12px;opacity:.65;white-space:pre-wrap}.tag{font-size:11px;opacity:.6}
input[type=text],textarea,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px 6px;font:inherit;width:100%;box-sizing:border-box}
textarea{min-height:56px;resize:vertical}input:focus,textarea:focus,select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.changed{border-color:var(--vscode-inputValidation-warningBorder,#b89500)!important}
.bar{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;padding:12px 0;background:var(--vscode-editor-background)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:5px 14px;cursor:pointer;font:inherit}
button:disabled{opacity:.5;cursor:default}button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.msg{font-size:12px}.err{color:var(--vscode-errorForeground)}.ok{color:var(--vscode-gitDecoration-addedResourceForeground)}.empty{opacity:.6;padding:8px 0}
</style></head><body>
<h2>IECode settings</h2>
<div id="form"></div>
<div class="bar"><button id="save" disabled>Save</button><button class="s" id="revert" disabled>Revert</button><span class="msg" id="msg"></span><span style="flex:1"></span><a href="#" id="json">Open settings.json</a></div>
<script type="application/json" id="data">${data}</script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const DATA = JSON.parse(document.getElementById('data').textContent);
const $ = id => document.getElementById(id);
const inputs = {};
let values = {};
for (const g of DATA.groups) {
  const list = DATA.fields.filter(f => f.group === g);
  const h = document.createElement('h3'); h.textContent = g; $('form').append(h);
  if (!list.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No settings yet.'; $('form').append(e); continue; }
  for (const f of list) {
    const row = document.createElement('div'); row.className = 'row';
    const lbl = document.createElement('label'); lbl.htmlFor = 'f_' + f.key; lbl.textContent = f.label;
    if (f.userOnly) { const t = document.createElement('div'); t.className = 'tag'; t.textContent = 'user settings only'; lbl.append(t); }
    let ctl;
    if (f.type === 'boolean') { ctl = document.createElement('input'); ctl.type = 'checkbox'; }
    else if (f.type === 'enum') {
      ctl = document.createElement('select');
      f.enum.forEach((v, i) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (f.enumDescriptions && f.enumDescriptions[i]) o.title = f.enumDescriptions[i]; ctl.append(o); });
    }
    else if (f.type === 'list' || f.type === 'object') { ctl = document.createElement('textarea'); ctl.spellcheck = false; }
    else { ctl = document.createElement('input'); ctl.type = 'text'; ctl.spellcheck = false; }
    ctl.id = 'f_' + f.key;
    ctl.addEventListener(f.type === 'boolean' || f.type === 'enum' ? 'change' : 'input', update);
    inputs[f.key] = ctl;
    row.append(lbl, ctl);
    let text = f.description;
    if (f.type === 'list') text += '\\nOne entry per line.';
    if (f.type === 'enum' && f.enumDescriptions) text += '\\n' + f.enum.map((v, i) => v + ': ' + (f.enumDescriptions[i] || '')).join('\\n');
    if (text) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = text; row.append(d); }
    $('form').append(row);
  }
}
const valueOf = f => f.type === 'boolean' ? inputs[f.key].checked : inputs[f.key].value;
const shown = f => f.type === 'boolean' ? values[f.key] === 'true' : (values[f.key] ?? '');
const same = f => f.type === 'boolean' ? valueOf(f) === shown(f) : valueOf(f).trim() === String(shown(f)).trim();
const changes = () => Object.fromEntries(DATA.fields.filter(f => !same(f)).map(f => [f.key, valueOf(f)]));
function update() {
  const c = changes();
  for (const f of DATA.fields) inputs[f.key].classList.toggle('changed', f.key in c);
  $('save').disabled = $('revert').disabled = !Object.keys(c).length;
}
function fill() {
  for (const f of DATA.fields) { if (f.type === 'boolean') inputs[f.key].checked = shown(f); else inputs[f.key].value = shown(f); }
  update();
}
$('save').onclick = () => { const c = changes(); if (Object.keys(c).length) { $('msg').className = 'msg'; $('msg').textContent = 'Saving...'; vscode.postMessage({ type: 'save', values: c }); } };
$('revert').onclick = () => { fill(); $('msg').textContent = ''; };
$('json').onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'openJson' }); };
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'values') {
    const pending = changes();
    values = m.values; fill();
    // keep what is being typed when a setting changes elsewhere, unless it was just saved
    if (!m.saved) for (const f of DATA.fields) if (f.key in pending) { if (f.type === 'boolean') inputs[f.key].checked = pending[f.key]; else inputs[f.key].value = pending[f.key]; }
    update();
    if (m.saved) { $('msg').className = 'msg ok'; $('msg').textContent = 'Saved.'; }
  }
  if (m.type === 'error') { $('msg').className = 'msg err'; $('msg').textContent = m.message; }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
