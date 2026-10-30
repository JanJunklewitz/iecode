// Project settings editor: title, company, version, released, namespace, placeholder, author, description and
// compiler defines of a PLC project (.plcproj), as on TwinCAT's Common property page. Saves through a
// WorkspaceEdit on the project file, so undo works and only the changed lines are touched.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PROJECT_SETTINGS, SettingKey, checkSetting, readProjectSettings, setProjectSettings } from '../core/plcproj';
import { GLOBAL_VERSION_REL, addGlobalVersionEntry, globalVersionRel, newGlobalVersion, updateGlobalVersion } from '../core/globalVersion';

type Msg =
  | { type: 'ready' }
  | { type: 'save'; values: Partial<Record<SettingKey, string>> }
  | { type: 'openFile' };

const panels = new Map<string, vscode.WebviewPanel>();

/**
 * Global_Version.TcGVL for the new title / version: updated when the project has one, created (with its .plcproj
 * entry) for a library project without. Returns the .plcproj text to save and the file to write, if any.
 */
async function globalVersion(dir: vscode.Uri, plcproj: string, s: Record<SettingKey, string>):
  Promise<{ plcproj: string; file?: vscode.Uri; text?: string; note: string }> {
  const rel = globalVersionRel(plcproj);
  const file = vscode.Uri.joinPath(dir, ...(rel ?? GLOBAL_VERSION_REL).split('/'));
  const old = await vscode.workspace.fs.readFile(file).then(b => Buffer.from(b).toString('utf8'), () => undefined);
  if (old !== undefined) {
    let text: string;
    try { text = updateGlobalVersion(old, s.Title, s.ProjectVersion); }
    catch { return { plcproj, note: 'Global_Version has no stLibVersion_ constant; TwinCAT regenerates it on build.' }; }
    return { plcproj: rel ? plcproj : addGlobalVersionEntry(plcproj), file: text === old ? undefined : file, text, note: 'Global_Version updated.' };
  }
  if (!s.Company) return { plcproj, note: '' };   // not a library: TwinCAT doesn't generate one either
  return { plcproj: addGlobalVersionEntry(plcproj, rel ?? GLOBAL_VERSION_REL), file, text: newGlobalVersion(s.Title, s.ProjectVersion), note: 'Global_Version created.' };
}

export function showProjectSettings(plcproj: string) {
  const open = panels.get(plcproj);
  if (open) { open.reveal(); return; }
  const file = vscode.Uri.file(plcproj);
  const panel = vscode.window.createWebviewPanel('iecode.projectSettings', `Settings: ${path.basename(plcproj, '.plcproj')}`, vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true });
  panels.set(plcproj, panel);
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);
  const post = (m: unknown) => panel.webview.postMessage(m);

  const send = async (saved?: boolean, note = '') => {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      post({ type: 'settings', name: path.basename(plcproj, '.plcproj'), file: vscode.workspace.asRelativePath(file), values: readProjectSettings(doc.getText()), saved, note });
    } catch (e) {
      post({ type: 'error', message: `Cannot read ${path.basename(plcproj)}: ${(e as Error).message}` });
    }
  };

  const subs = [
    panel.webview.onDidReceiveMessage(async (m: Msg) => {
      if (m.type === 'ready') return send();
      if (m.type === 'openFile') return vscode.window.showTextDocument(file, { preview: false });
      if (m.type === 'save') {
        const problem = Object.entries(m.values).map(([k, v]) => checkSetting(k as SettingKey, v ?? '')).find(Boolean);
        if (problem) return post({ type: 'error', message: problem });
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const text = doc.getText();
          let next = setProjectSettings(text, m.values);
          const was = readProjectSettings(text), now = readProjectSettings(next);
          // TwinCAT regenerates Global_Version only on build: keep it in step with title and version
          const gv = now.Title && now.ProjectVersion && (was.Title !== now.Title || was.ProjectVersion !== now.ProjectVersion)
            ? await globalVersion(vscode.Uri.file(path.dirname(plcproj)), next, now) : undefined;
          if (gv) next = gv.plcproj;
          if (next !== text) {
            const we = new vscode.WorkspaceEdit();
            we.replace(file, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
            if (!await vscode.workspace.applyEdit(we) || !await doc.save()) throw new Error('the file could not be written');
          }
          if (gv?.file && gv.text !== undefined) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(gv.file, '..'));
            await vscode.workspace.fs.writeFile(gv.file, Buffer.from(gv.text, 'utf8'));
          }
          return send(true, gv?.note);
        } catch (e) {
          return post({ type: 'error', message: `Not saved: ${(e as Error).message}` });
        }
      }
    }),
    // edited elsewhere (text editor, TwinCAT, git): show the new values
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.uri.fsPath === file.fsPath && e.contentChanges.length) void send(); }),
    panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) void send(); }),
  ];
  panel.onDidDispose(() => { panels.delete(plcproj); subs.forEach(s => s.dispose()); });
}

function html(nonce: string, csp: string): string {
  const fields = JSON.stringify(PROJECT_SETTINGS);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:16px 20px;max-width:760px}
h2{font-size:15px;margin:0 0 2px}.dim{opacity:.7;font-size:12px}a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}
.row{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;align-items:start;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border)}
.row label{padding-top:4px}.hint{grid-column:2;font-size:12px;opacity:.65}
input[type=text],textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px 6px;font:inherit;width:100%;box-sizing:border-box}
textarea{min-height:56px;resize:vertical}input:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
input.changed,textarea.changed{border-color:var(--vscode-inputValidation-warningBorder,#b89500)}
.bar{display:flex;gap:10px;align-items:center;padding:14px 0 0}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:5px 14px;cursor:pointer;font:inherit}
button:disabled{opacity:.5;cursor:default}button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.msg{font-size:12px}.err{color:var(--vscode-errorForeground)}.ok{color:var(--vscode-gitDecoration-addedResourceForeground)}
.lib{margin:8px 0 4px;font-size:12px}
</style></head><body>
<h2 id="name">PLC project</h2><div class="dim"><a href="#" id="file"></a></div>
<div class="lib dim" id="lib"></div>
<form id="form"></form>
<div class="bar"><button id="save" disabled>Save</button><button class="s" id="revert" disabled>Revert</button><span class="msg" id="msg"></span></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const FIELDS = ${fields};
const $ = id => document.getElementById(id);
let values = {};
const inputs = {};
for (const f of FIELDS) {
  const row = document.createElement('div'); row.className = 'row';
  const lbl = document.createElement('label'); lbl.textContent = f.label; lbl.htmlFor = 'f_' + f.key;
  let ctl;
  if (f.kind === 'bool') { ctl = document.createElement('input'); ctl.type = 'checkbox'; }
  else if (f.kind === 'multiline') ctl = document.createElement('textarea');
  else { ctl = document.createElement('input'); ctl.type = 'text'; ctl.spellcheck = false; }
  ctl.id = 'f_' + f.key;
  ctl.addEventListener(f.kind === 'bool' ? 'change' : 'input', update);
  if (f.kind !== 'multiline') ctl.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  inputs[f.key] = ctl;
  row.append(lbl, ctl);
  if (f.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = f.hint; row.append(h); }
  $('form').append(row);
}
const valueOf = f => f.kind === 'bool' ? (inputs[f.key].checked ? 'true' : (values[f.key] === '' ? '' : 'false')) : inputs[f.key].value;
const changes = () => Object.fromEntries(FIELDS.filter(f => valueOf(f).trim() !== (values[f.key] || '').trim()).map(f => [f.key, valueOf(f)]));
function update() {
  const c = changes();
  for (const f of FIELDS) inputs[f.key].classList.toggle('changed', f.key in c);
  $('save').disabled = $('revert').disabled = !Object.keys(c).length;
  const v = k => (k in c ? c[k] : values[k] || '').trim();
  $('lib').textContent = v('Title') && v('Company') && v('ProjectVersion')
    ? 'Library: ' + v('Title') + ', ' + v('ProjectVersion') + ' (' + v('Company') + ')'
    : 'Not a library: set Title, Company and Version to save it as one.';
}
function fill() {
  for (const f of FIELDS) { if (f.kind === 'bool') inputs[f.key].checked = values[f.key] === 'true'; else inputs[f.key].value = values[f.key] || ''; }
  update();
}
function save() { const c = changes(); if (Object.keys(c).length) { $('msg').className = 'msg'; $('msg').textContent = 'Saving…'; vscode.postMessage({ type: 'save', values: c }); } }
$('save').onclick = save;
$('revert').onclick = () => { fill(); $('msg').textContent = ''; };
$('file').onclick = ev => { ev.preventDefault(); vscode.postMessage({ type: 'openFile' }); };
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'settings') {
    const pending = changes();
    values = m.values; $('name').textContent = m.name; $('file').textContent = m.file;
    fill();
    // keep what the user is typing when the file changes underneath, unless it was just saved
    if (!m.saved) for (const f of FIELDS) if (f.key in pending) { if (f.kind === 'bool') inputs[f.key].checked = pending[f.key] === 'true'; else inputs[f.key].value = pending[f.key]; }
    update();
    $('msg').className = 'msg ok'; $('msg').textContent = m.saved ? 'Saved.' + (m.note ? ' ' + m.note : '') : '';
  }
  if (m.type === 'error') { $('msg').className = 'msg err'; $('msg').textContent = m.message; }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
