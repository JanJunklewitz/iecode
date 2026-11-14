// Add / rename / delete PLC objects, members and folders. Works directly on the files (no TwinCAT needed).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Node } from '../views/tree';
import { WorkspaceState } from '../state';
import { Unit } from '../core/workspace';
import { addMemberFolder, listMemberFolders, moveMemberToFolder } from '../core/projects';
import {
  Access, FILE_EXT, IDENT_RE, NAME_PREFIX, NewObjectKind, actionSection, addSections, guid,
  methodSection, newObjectXml, propertySection,
} from '../core/templates';
import { addCompile, addFolder, removeCompile, removeFolder, renameObjectXml, renamePath } from '../core/plcproj';
import { decode, encode, parseView, HEADER_RE } from '../model';
import { LibrarySources } from '../lang/librarySources';
import type { LanguageApi } from '../lang/providers';

const BUILTIN_TYPES = ['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
  'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'TOD', 'DT', 'STRING', 'WSTRING', 'HRESULT'];

const KINDS: { type: NewObjectKind; label: string; detail: string }[] = [
  { type: 'FUNCTION_BLOCK', label: 'Function Block', detail: 'FUNCTION_BLOCK, optional EXTENDS / IMPLEMENTS' },
  { type: 'PROGRAM', label: 'Program', detail: 'PROGRAM' },
  { type: 'FUNCTION', label: 'Function', detail: 'FUNCTION with return type' },
  { type: 'INTERFACE', label: 'Interface', detail: 'INTERFACE, optional EXTENDS' },
  { type: 'STRUCT', label: 'Struct', detail: 'TYPE … STRUCT' },
  { type: 'ENUM', label: 'Enum', detail: 'TYPE … ( … ) with qualified_only / strict' },
  { type: 'UNION', label: 'Union', detail: 'TYPE … UNION' },
  { type: 'ALIAS', label: 'Alias', detail: 'TYPE X : <base type>' },
  { type: 'GVL', label: 'Global Variable List', detail: 'VAR_GLOBAL with qualified_only' },
];

/** Where new objects go if the user didn't pick a folder. */
const DEFAULT_FOLDER: Record<NewObjectKind, string> = {
  FUNCTION_BLOCK: 'POUs', PROGRAM: 'POUs', FUNCTION: 'POUs', INTERFACE: 'Interfaces',
  STRUCT: 'DUTs', ENUM: 'DUTs', UNION: 'DUTs', ALIAS: 'DUTs', GVL: 'GVLs',
};

const readText = (f: string) => fs.readFile(f, 'utf8');
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const bomOf = (s: string) => (s.charCodeAt(0) === 0xfeff ? '\ufeff' : '');

function existingNames(unit: Unit) {
  return new Set(unit.plc.objects.map(o => o.name.toLowerCase()));
}

async function askName(prompt: string, value: string, taken: Set<string>): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt, value, valueSelection: [value.length, value.length],
    validateInput: v => !IDENT_RE.test(v) ? 'Use letters, digits and _ (not starting with a digit)'
      : taken.has(v.toLowerCase()) ? `${v} already exists` : undefined,
  });
}

async function askType(prompt: string, unit: Unit, placeholder = 'Leave empty for none'): Promise<string | undefined> {
  const own = unit.plc.objects.filter(o => ['STRUCT', 'ENUM', 'UNION', 'ALIAS', 'FUNCTION_BLOCK', 'INTERFACE'].includes(o.type)).map(o => o.name);
  const items: vscode.QuickPickItem[] = [
    ...BUILTIN_TYPES.map(t => ({ label: t, description: 'built-in' })),
    ...own.map(t => ({ label: t, description: 'project' })),
  ];
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick();
    qp.title = prompt;
    qp.placeholder = placeholder;
    qp.items = items;
    let value = '';
    qp.onDidChangeValue(v => (value = v));
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]?.label ?? value.trim()); qp.hide(); });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
}

async function askAccess(): Promise<Access | undefined> {
  const pick = await vscode.window.showQuickPick(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL'], { title: 'Access' });
  return pick as Access | undefined;
}

/** Writes a file with a new object, registers it (and its folders) in the .plcproj and opens it. */
const objectPath = (unit: Unit, folderRel: string, kind: NewObjectKind, name: string) =>
  path.join(unit.plc.dir, ...((folderRel ? folderRel + '/' : '') + name + FILE_EXT[kind]).split('/'));

async function createObject(unit: Unit, folderRel: string, kind: NewObjectKind, name: string, xml: string) {
  const rel = (folderRel ? folderRel + '/' : '') + name + FILE_EXT[kind];
  const abs = objectPath(unit, folderRel, kind, name);
  try { await fs.access(abs); throw new Error(`${rel} already exists`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, xml, 'utf8');
  let proj = await readText(unit.plc.file);
  if (folderRel) proj = addFolder(proj, folderRel);
  proj = addCompile(proj, rel);
  await fs.writeFile(unit.plc.file, proj, 'utf8');
  await vscode.commands.executeCommand('iecode.openAsST', vscode.Uri.file(abs));
}

/** Function blocks or interfaces known to the language index (workspace and referenced libraries), workspace first. */
function knownTypes(lang: LanguageApi, kind: 'FUNCTION_BLOCK' | 'INTERFACE', unit: Unit, exclude?: string): vscode.QuickPickItem[] {
  const seen = new Set<string>();
  const own = new Set(unit.plc.objects.map(o => o.file));
  return lang.index.objects()
    .filter(o => o.root?.kind === kind && o.root.name.toLowerCase() !== exclude?.toLowerCase())
    .sort((a, b) => Number(!own.has(a.file)) - Number(!own.has(b.file)) || Number(!!a.library) - Number(!!b.library) || a.root!.name.localeCompare(b.root!.name))
    .filter(o => !seen.has(o.root!.name.toLowerCase()) && !!seen.add(o.root!.name.toLowerCase()))
    .map(o => ({
      label: o.root!.name,
      description: [o.library ? `library ${o.library}` : own.has(o.file) ? 'project' : 'workspace', o.root!.modifiers?.includes('ABSTRACT') && 'abstract'].filter(Boolean).join(' · '),
    }));
}

/** New function block XML with stubs for everything its base class and interfaces require. */
async function functionBlockXml(lang: LanguageApi, unit: Unit, folder: string, name: string, ext: string | undefined, impl: string[]): Promise<string> {
  await lang.ready();
  const xml = newObjectXml('FUNCTION_BLOCK', name, { extends: ext, implements: impl, productVersion: unit.plc.tcVersion });
  const stubs = lang.stubsFor(objectPath(unit, folder, 'FUNCTION_BLOCK', name), decode(stripBom(xml)));
  return stubs ? addSections(xml, stubs) : xml;
}

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState, lang: LanguageApi) {
  const reg = (id: string, fn: (...a: never[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
      try { await fn(...args); await state.reload(); }
      catch (e) { vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); }
    }));

  reg('iecode.addObject', async (n?: Node, preset?: NewObjectKind) => {
    const unit = n && 'unit' in n ? n.unit : await pickUnit(state);
    if (!unit) return;
    const pick = preset ? KINDS.find(k => k.type === preset) : await vscode.window.showQuickPick(KINDS, { title: `Add to ${unit.plc.name}` });
    if (!pick) return;
    const folder = n?.kind === 'folder' ? n.rel : DEFAULT_FOLDER[pick.type];
    const name = await askName(`${pick.label} name`, NAME_PREFIX[pick.type], existingNames(unit));
    if (!name) return;

    const productVersion = unit.plc.tcVersion;
    if (pick.type === 'FUNCTION_BLOCK') {
      await lang.ready();
      const fbs = knownTypes(lang, 'FUNCTION_BLOCK', unit);
      const base = fbs.length ? await vscode.window.showQuickPick([{ label: '(none)' }, ...fbs], { title: 'EXTENDS (abstract members are stubbed)', matchOnDescription: true }) : undefined;
      if (fbs.length && !base) return;
      const itfs = knownTypes(lang, 'INTERFACE', unit);
      const chosen = itfs.length ? await vscode.window.showQuickPick(itfs, { title: 'IMPLEMENTS (stubs are created for all members)', canPickMany: true, matchOnDescription: true }) : [];
      if (!chosen) return;
      const ext = base && base.label !== '(none)' ? base.label : undefined;
      return createObject(unit, folder, 'FUNCTION_BLOCK', name, await functionBlockXml(lang, unit, folder, name, ext, chosen.map(c => c.label)));
    }
    if (pick.type === 'INTERFACE') {
      const itfs = unit.plc.objects.filter(o => o.type === 'INTERFACE');
      const base = itfs.length ? await vscode.window.showQuickPick(itfs.map(o => ({ label: o.name })), { title: 'EXTENDS (optional)', canPickMany: true }) : [];
      if (!base) return;
      return createObject(unit, folder, 'INTERFACE', name, newObjectXml('INTERFACE', name, { extends: base.map(b => b.label).join(', ') || undefined, productVersion }));
    }
    if (pick.type === 'FUNCTION' || pick.type === 'ALIAS') {
      const type = await askType(pick.type === 'FUNCTION' ? 'Return type' : 'Base type', unit, pick.type === 'FUNCTION' ? 'BOOL' : 'INT');
      if (type === undefined) return;
      return createObject(unit, folder, pick.type, name, newObjectXml(pick.type, name, { type: type || undefined, productVersion }));
    }
    return createObject(unit, folder, pick.type, name, newObjectXml(pick.type, name, { productVersion }));
  });

  reg('iecode.addMember', async (n?: Node, preset?: 'METHOD' | 'PROPERTY' | 'ACTION' | 'IMPLEMENT') => {
    if (n?.kind !== 'object' && n?.kind !== 'member' && n?.kind !== 'memberFolder') return;
    const { unit, obj } = n;
    // added inside a TwinCAT folder of the POU
    const intoFolder = n.kind === 'memberFolder' && !n.rel.startsWith('#') ? n.rel : '';
    const isItf = obj.type === 'INTERFACE';
    const options = [
      { label: 'Method…', id: 'METHOD' as const },
      { label: 'Property…', id: 'PROPERTY' as const },
      ...(isItf ? [] : [{ label: 'Action…', id: 'ACTION' as const }, { label: 'Implement interface…', id: 'IMPLEMENT' as const }]),
    ];
    const what = preset ?? (await vscode.window.showQuickPick(options, { title: `Add to ${obj.name}` }))?.id;
    if (!what) return;
    const xml = await readText(obj.file);
    const taken = new Set(parseView(decode(stripBom(xml))).map(s => s.name.toLowerCase()));
    let sections = '';
    if (what === 'METHOD') {
      const name = await askName('Method name', '', taken); if (!name) return;
      const ret = await askType('Return type', unit); if (ret === undefined) return;
      const access = isItf ? undefined : await askAccess(); if (!isItf && !access) return;
      sections = methodSection({ name, returnType: ret || undefined, access }, isItf);
    } else if (what === 'PROPERTY') {
      const name = await askName('Property name', '', taken); if (!name) return;
      const type = await askType('Property type', unit, 'Type is required'); if (!type) return;
      const acc = await vscode.window.showQuickPick(['Get and Set', 'Get only', 'Set only'], { title: 'Accessors' }); if (!acc) return;
      const access = isItf ? undefined : await askAccess(); if (!isItf && !access) return;
      sections = propertySection({ name, type, access, get: acc !== 'Set only', set: acc !== 'Get only' }, isItf);
    } else if (what === 'ACTION') {
      const name = await askName('Action name', '', taken); if (!name) return;
      sections = actionSection(name);
    } else {
      await lang.ready();
      const chosen = await vscode.window.showQuickPick(knownTypes(lang, 'INTERFACE', unit), { title: 'Implement interfaces', canPickMany: true, matchOnDescription: true });
      if (!chosen?.length) return;
      const updated = addImplements(xml, chosen.map(c => c.label));
      sections = lang.stubsFor(obj.file, decode(stripBom(updated)));
      await fs.writeFile(obj.file, sections ? addSections(updated, sections) : updated, 'utf8');
      return;
    }
    let out = addSections(xml, sections);
    const name = /^\/\/==== \w+ (\w+) ====/.exec(sections)![1];
    if (intoFolder) out = moveMemberToFolder(out, what, name, intoFolder);
    await fs.writeFile(obj.file, out, 'utf8');
    await revealSection(obj.file, name);
  });

  // a new function block that EXTENDS this one, with stubs for its abstract members and interfaces
  reg('iecode.extendFunctionBlock', async (n?: Node) => {
    const baseName = n?.kind === 'object' ? n.obj.name : n?.kind === 'libraryObject' ? n.obj.name : undefined;
    if (!baseName) return;
    const unit = n?.kind === 'object' ? n.unit : await pickUnit(state);
    if (!unit) return;
    const folder = n?.kind === 'object' ? path.posix.dirname(n.obj.rel).replace(/^\.$/, '') : DEFAULT_FOLDER.FUNCTION_BLOCK;
    const name = await askName(`Function block that extends ${baseName}`, NAME_PREFIX.FUNCTION_BLOCK, existingNames(unit));
    if (!name) return;
    await createObject(unit, folder, 'FUNCTION_BLOCK', name, await functionBlockXml(lang, unit, folder, name, baseName, []));
  });

  // TwinCAT folders inside a POU / interface
  reg('iecode.addMemberFolder', async (n?: Node) => {
    if (n?.kind !== 'object' && n?.kind !== 'memberFolder') return;
    const parent = n.kind === 'memberFolder' && !n.rel.startsWith('#') ? n.rel : '';
    const name = await vscode.window.showInputBox({ prompt: `Folder in ${n.obj.name}${parent ? '/' + parent : ''}`, validateInput: v => /^[^\\/:*?"<>|]+$/.test(v) ? undefined : 'Invalid folder name' });
    if (!name) return;
    await fs.writeFile(n.obj.file, addMemberFolder(await readText(n.obj.file), parent ? `${parent}/${name}` : name, guid()), 'utf8');
  });

  reg('iecode.moveMember', async (n?: Node) => {
    if (n?.kind !== 'member') return;
    const xml = await readText(n.obj.file);
    const folders = listMemberFolders(xml);
    const NEW = '$(new-folder) New folder…', TOP = '$(root-folder) (top level)';
    const pick = await vscode.window.showQuickPick([TOP, ...folders.filter(f => f !== n.member.folder), NEW], { title: `Move ${n.member.name} to folder` });
    if (!pick) return;
    let folder = pick === TOP ? '' : pick;
    let out = xml;
    if (pick === NEW) {
      const name = await vscode.window.showInputBox({ prompt: 'New folder (use / for sub folders)', validateInput: v => /^[^\\:*?"<>|]+$/.test(v) && !v.split('/').some(p => !p) ? undefined : 'Invalid folder name' });
      if (!name) return;
      folder = name;
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const f = parts.slice(0, i).join('/');
        if (!listMemberFolders(out).some(x => x.toLowerCase() === f.toLowerCase())) out = addMemberFolder(out, f, guid());
      }
    }
    // a property's accessors move with it (they are its children in the XML)
    await fs.writeFile(n.obj.file, moveMemberToFolder(out, n.member.kind, n.member.name, folder), 'utf8');
  });

  reg('iecode.addFolder', async (n?: Node) => {
    if (n?.kind !== 'unit' && n?.kind !== 'folder') return;
    const parent = n.kind === 'folder' ? n.rel : '';
    const name = await vscode.window.showInputBox({ prompt: 'Folder name', validateInput: v => /^[^\\/:*?"<>|]+$/.test(v) ? undefined : 'Invalid folder name' });
    if (!name) return;
    const rel = parent ? `${parent}/${name}` : name;
    await fs.mkdir(path.join(n.unit.plc.dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(n.unit.plc.file, addFolder(await readText(n.unit.plc.file), rel), 'utf8');
  });

  reg('iecode.rename', async (n?: Node) => {
    if (n?.kind === 'object') {
      const o = n.obj;
      const name = await askName(`Rename ${o.name}`, o.name, new Set([...existingNames(n.unit)].filter(x => x !== o.name.toLowerCase())));
      if (!name || name === o.name) return;
      const newRel = path.posix.join(path.posix.dirname(o.rel), name + path.extname(o.rel)).replace(/^\.\//, '');
      const newAbs = path.join(n.unit.plc.dir, ...newRel.split('/'));
      await fs.writeFile(o.file, renameObjectXml(await readText(o.file), o.name, name), 'utf8');
      await fs.rename(o.file, newAbs);
      await fs.writeFile(n.unit.plc.file, renamePath(await readText(n.unit.plc.file), o.rel, newRel), 'utf8');
      vscode.window.showInformationMessage(`Renamed ${o.name} to ${name}. References to it in other objects are not changed.`);
    } else if (n?.kind === 'folder') {
      const old = path.posix.basename(n.rel);
      const name = await vscode.window.showInputBox({ prompt: `Rename folder ${old}`, value: old });
      if (!name || name === old) return;
      const newRel = path.posix.join(path.posix.dirname(n.rel), name).replace(/^\.\//, '');
      await fs.rename(path.join(n.unit.plc.dir, ...n.rel.split('/')), path.join(n.unit.plc.dir, ...newRel.split('/')));
      await fs.writeFile(n.unit.plc.file, renamePath(await readText(n.unit.plc.file), n.rel, newRel), 'utf8');
    } else if (n?.kind === 'member') {
      const raw = await readText(n.obj.file);
      const xml = stripBom(raw);
      const name = await askName(`Rename ${n.member.name}`, n.member.name, new Set());
      if (!name || name === n.member.name) return;
      const kind = n.member.kind;
      const re = new RegExp(`^//==== (${kind}|GET|SET) ${n.member.name} ====$`, 'gm');
      const view = decode(xml).replace(re, (_m, k) => `//==== ${k} ${name} ====`)
        .replace(new RegExp(`^(\\s*${kind}\\s+(?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\\s+)*)${n.member.name}\\b`, 'mi'), `$1${name}`);
      // A renamed section is stored as a new element (new GUID); TwinCAT treats it like delete + add.
      await fs.writeFile(n.obj.file, bomOf(raw) + encode(xml, view), 'utf8');
    }
  });

  reg('iecode.delete', async (n?: Node) => {
    if (n?.kind === 'object') {
      const ok = await vscode.window.showWarningMessage(`Delete ${n.obj.name}? The file is removed and taken out of ${n.unit.plc.name}.`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      await fs.writeFile(n.unit.plc.file, removeCompile(await readText(n.unit.plc.file), n.obj.rel), 'utf8');
      await vscode.workspace.fs.delete(vscode.Uri.file(n.obj.file), { useTrash: true });
    } else if (n?.kind === 'folder') {
      const count = n.unit.plc.objects.filter(o => o.rel.startsWith(n.rel + '/')).length;
      const ok = await vscode.window.showWarningMessage(`Delete folder ${n.rel} with ${count} object(s)?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      await fs.writeFile(n.unit.plc.file, removeFolder(await readText(n.unit.plc.file), n.rel), 'utf8');
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(n.unit.plc.dir, ...n.rel.split('/'))), { recursive: true, useTrash: true });
    } else if (n?.kind === 'member') {
      const ok = await vscode.window.showWarningMessage(`Delete ${n.member.kind.toLowerCase()} ${n.member.name} from ${n.obj.name}?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      const raw = await readText(n.obj.file);
      const xml = stripBom(raw);
      await fs.writeFile(n.obj.file, bomOf(raw) + encode(xml, removeMemberFromView(decode(xml), n.member.kind, n.member.name)), 'utf8');
    }
  });

  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.revealMember', (n: Node) => {
    if (n?.kind === 'member') return revealSection(n.obj.file, n.member.name);
    if (n?.kind === 'libraryMember') return revealSection(LibrarySources.uri(n.key), n.member.name);
  }));
}

/** Adds names to the IMPLEMENTS clause of a function block declaration. */
function addImplements(xml: string, names: string[]): string {
  return xml.replace(/(<Declaration><!\[CDATA\[(?:\s*\{[^}]*\}\s*)*\s*FUNCTION_BLOCK\b[^\r\n]*?)(\s*IMPLEMENTS\s+([\w.,\s]+?))?(\r?\n)/i,
    (_m, head: string, impl: string | undefined, list: string | undefined, eol: string) => {
      const have = (list ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const all = [...have, ...names.filter(n => !have.some(h => h.toLowerCase() === n.toLowerCase()))];
      return `${head} IMPLEMENTS ${all.join(', ')}${eol}`;
    });
}

/** Removes a member's sections (for a property also its GET / SET) from the view text. */
export function removeMemberFromView(view: string, kind: string, name: string): string {
  const own = (l: string) => {
    const m = HEADER_RE.exec(l);
    return !!m && m[2] === name && (m[1] === kind || (kind === 'PROPERTY' && (m[1] === 'GET' || m[1] === 'SET')));
  };
  const out: string[] = [];
  let skipping = false;
  for (const l of view.split('\n')) {
    if (HEADER_RE.test(l)) skipping = own(l);
    if (!skipping) out.push(l);
  }
  return out.join('\n');
}

/** Opens an object's ST view (a file, or a library object's iecode-lib: URI) at a member's section. */
async function revealSection(file: string | vscode.Uri, name: string) {
  if (typeof file === 'string') await vscode.commands.executeCommand('iecode.openAsST', vscode.Uri.file(file));
  else await vscode.window.showTextDocument(file, { preview: false });
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const text = ed.document.getText();
  const at = text.search(new RegExp(`^//==== \\w+ ${name} ====`, 'm'));
  if (at < 0) return;
  const pos = ed.document.positionAt(at);
  ed.selection = new vscode.Selection(pos.translate(1), pos.translate(1));
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
}

async function pickUnit(state: WorkspaceState): Promise<Unit | undefined> {
  const units = state.current.units;
  if (units.length <= 1) return units[0];
  const pick = await vscode.window.showQuickPick(units.map(u => ({ label: u.id, description: u.group, u })), { title: 'PLC project' });
  return pick?.u;
}
