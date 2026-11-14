// Files created, deleted, renamed or moved in VS Code (explorer, paste, drag and drop, refactorings) are
// registered in / removed from / moved in the .plcproj they belong to, so TwinCAT sees the same project.
// Files written by other programs (git checkout, TwinCAT) are not touched.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { Unit } from '../core/workspace';
import { IDENT_RE, NewObjectKind, newObjectXml } from '../core/templates';
import { renameObjectXml } from '../core/plcproj';
import {
  freshIds, isTcObjectFile, movePath, objectName, registerPaths, relInProject, templateKinds, unregisterPaths,
} from '../core/projectFiles';

const KIND_LABEL: Record<NewObjectKind, string> = {
  FUNCTION_BLOCK: 'Function Block', PROGRAM: 'Program', FUNCTION: 'Function', INTERFACE: 'Interface',
  STRUCT: 'Struct', ENUM: 'Enum', UNION: 'Union', ALIAS: 'Alias', GVL: 'Global Variable List',
};

const enabled = () => vscode.workspace.getConfiguration('iecode').get<boolean>('syncProjectFiles', true);
const stat = (f: string) => fs.stat(f).catch(() => undefined);

/** The PLC project a path belongs to (the innermost one) and the path relative to it. */
function owner(state: WorkspaceState, file: string): { unit: Unit; rel: string } | undefined {
  let best: { unit: Unit; rel: string } | undefined;
  for (const unit of state.current.units) {
    const rel = relInProject(unit.plc.dir, file);
    if (rel !== undefined && (!best || unit.plc.dir.length > best.unit.plc.dir.length)) best = { unit, rel };
  }
  return best;
}

/** Applies an edit to a .plcproj; writes only when something changed. */
async function editProject(projectFile: string, edit: (text: string) => string): Promise<boolean> {
  const before = await fs.readFile(projectFile, 'utf8');
  const after = edit(before);
  if (after === before) return false;
  await fs.writeFile(projectFile, after, 'utf8');
  return true;
}

/** A new folder with the object files and folders below it (TwinCAT output and hidden folders skipped). */
async function collect(dir: string): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [], folders: string[] = [dir];
  const visit = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { folders.push(p); await visit(p); }
      else if (isTcObjectFile(p)) files.push(p);
    }
  };
  await visit(dir);
  return { files, folders };
}

/**
 * Prepares a new object file before it is registered: an empty file gets a template, a copy gets the file's name
 * and new GUIDs. Returns false when the file can't be added to the project.
 */
async function prepare(unit: Unit, file: string, warnings: string[]): Promise<boolean> {
  const base = path.basename(file, path.extname(file));
  const raw = await fs.readFile(file, 'utf8');
  const kinds = templateKinds(file);
  if (raw.trim() === '') {
    if (!kinds.length) {
      warnings.push(`${path.basename(file)} is empty; create ${path.extname(file)} files in TwinCAT XAE (or copy an existing one). It was not added to ${unit.plc.name}.`);
      return false;
    }
    if (!IDENT_RE.test(base)) {
      warnings.push(`${path.basename(file)}: the file name must be a valid identifier to be an object name. It was not added to ${unit.plc.name}.`);
      return false;
    }
    const kind = kinds.length === 1 ? kinds[0] : (await vscode.window.showQuickPick(
      kinds.map(k => ({ label: KIND_LABEL[k], objKind: k })), { title: `New ${path.extname(file)}: ${base}`, ignoreFocusOut: true }))?.objKind;
    if (!kind) { warnings.push(`${path.basename(file)} was not added to ${unit.plc.name}.`); return false; }
    await fs.writeFile(file, newObjectXml(kind, base, { productVersion: unit.plc.tcVersion }), 'utf8');
    return true;
  }
  if (!kinds.length) return true;
  // a copy (or a file from another project): the object takes the file's name; a duplicate gets new ids
  const name = objectName(raw);
  if (!name || name === base) return true;
  if (!IDENT_RE.test(base)) {
    warnings.push(`${path.basename(file)} contains ${name}; rename the file to a valid identifier to give the object its own name.`);
    return true;
  }
  const clash = unit.plc.objects.some(o => o.name.toLowerCase() === name.toLowerCase() && path.resolve(o.file) !== path.resolve(file));
  const renamed = renameObjectXml(raw, name, base);
  await fs.writeFile(file, clash ? freshIds(renamed) : renamed, 'utf8');
  return true;
}

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  /** Serializes the handlers: several events can touch the same .plcproj. */
  let queue = Promise.resolve();
  const run = (fn: () => Promise<void>) => {
    queue = queue.then(fn).catch(e => { vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); });
    return queue;
  };
  const report = (changed: Set<string>, warnings: string[]) => {
    for (const w of warnings) vscode.window.showWarningMessage(`IECode: ${w}`);
    if (changed.size) void state.reload();
  };

  ctx.subscriptions.push(vscode.workspace.onDidCreateFiles(e => run(async () => {
    if (!enabled()) return;
    const changed = new Set<string>(), warnings: string[] = [], toOpen: string[] = [];
    for (const uri of e.files.filter(u => u.scheme === 'file')) {
      const o = owner(state, uri.fsPath);
      if (!o) continue;
      const st = await stat(uri.fsPath);
      if (!st) continue;
      let files: string[] = [], folders: string[] = [];
      if (st.isDirectory()) ({ files, folders } = await collect(uri.fsPath));
      else if (isTcObjectFile(uri.fsPath)) {
        const wasEmpty = st.size === 0;
        if (!await prepare(o.unit, uri.fsPath, warnings)) continue;
        files = [uri.fsPath];
        if (wasEmpty) toOpen.push(uri.fsPath);
      } else continue;
      const ok: string[] = [];
      for (const f of files) if (f === uri.fsPath || await prepare(o.unit, f, warnings)) ok.push(f);
      const rel = (p: string) => relInProject(o.unit.plc.dir, p)!;
      if (await editProject(o.unit.plc.file, t => registerPaths(t, ok.map(rel), folders.map(rel)))) changed.add(o.unit.plc.file);
    }
    report(changed, warnings);
    for (const f of toOpen) await vscode.commands.executeCommand('iecode.openAsST', vscode.Uri.file(f));
  })));

  ctx.subscriptions.push(vscode.workspace.onDidDeleteFiles(e => run(async () => {
    if (!enabled()) return;
    const changed = new Set<string>();
    for (const uri of e.files.filter(u => u.scheme === 'file')) {
      const o = owner(state, uri.fsPath);
      if (!o || (path.extname(uri.fsPath) && !isTcObjectFile(uri.fsPath) && !o.unit.plc.folders.includes(o.rel))) continue;
      if (await editProject(o.unit.plc.file, t => unregisterPaths(t, [o.rel]))) changed.add(o.unit.plc.file);
    }
    report(changed, []);
  })));

  ctx.subscriptions.push(vscode.workspace.onDidRenameFiles(e => run(async () => {
    if (!enabled()) return;
    const changed = new Set<string>(), warnings: string[] = [];
    for (const { oldUri, newUri } of e.files.filter(f => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file')) {
      const from = owner(state, oldUri.fsPath), to = owner(state, newUri.fsPath);
      const st = await stat(newUri.fsPath);
      if (!st || (!st.isDirectory() && !isTcObjectFile(newUri.fsPath) && !isTcObjectFile(oldUri.fsPath))) continue;
      if (from && to && from.unit.plc.file === to.unit.plc.file
        && (st.isDirectory() || (isTcObjectFile(oldUri.fsPath) && isTcObjectFile(newUri.fsPath)))) {
        if (await editProject(to.unit.plc.file, t => movePath(t, from.rel, to.rel))) changed.add(to.unit.plc.file);
        if (!st.isDirectory()) await followName(oldUri.fsPath, newUri.fsPath, warnings);
        continue;
      }
      // into, out of or between projects: take it out of one and add it to the other
      // (also a file that only now has, or no longer has, an object file extension)
      if (from && await editProject(from.unit.plc.file, t => unregisterPaths(t, [from.rel]))) changed.add(from.unit.plc.file);
      if (!to) continue;
      let files: string[] = [], folders: string[] = [];
      if (st.isDirectory()) ({ files, folders } = await collect(newUri.fsPath));
      else if (isTcObjectFile(newUri.fsPath)) files = [newUri.fsPath];
      const ok: string[] = [];
      for (const f of files) if (await prepare(to.unit, f, warnings)) ok.push(f);
      const rel = (p: string) => relInProject(to.unit.plc.dir, p)!;
      if (await editProject(to.unit.plc.file, t => registerPaths(t, ok.map(rel), folders.map(rel)))) changed.add(to.unit.plc.file);
    }
    report(changed, warnings);
  })));
}

/** A renamed object file: the object inside takes the new file name, as TwinCAT does when renaming. */
async function followName(oldFile: string, newFile: string, warnings: string[]) {
  if (!templateKinds(newFile).length) return;
  const oldBase = path.basename(oldFile, path.extname(oldFile)), newBase = path.basename(newFile, path.extname(newFile));
  if (oldBase === newBase) return;
  const raw = await fs.readFile(newFile, 'utf8');
  const name = objectName(raw);
  if (!name || name !== oldBase) return;
  if (!IDENT_RE.test(newBase)) { warnings.push(`${path.basename(newFile)}: not a valid identifier, the object is still named ${name}.`); return; }
  await fs.writeFile(newFile, renameObjectXml(raw, name, newBase), 'utf8');
}
