// Stage or discard one method, property or action from the ST view: CodeLenses above every changed section.
// Works on the file on disk and the git index; a dirty view or raw XML document is refused ("save first").

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import * as vscode from 'vscode';
import { GuardInput, SafeWriteIo, changedSections, decodeUtf8Strict, discardConfirmText, discardGuard, discardSection, hasMixedEol, stageGuard, stageSection, writeFileSafe } from '../core/objectStage';
import { NotUtf8Error, indexEntry, indexHasConflict, readIndex, repoRoot, writeIndexBlob } from '../core/git';
import { decode, outline } from '../model';

const SCHEME = 'iecode';
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

interface Snapshot { root: string; file: vscode.Uri; work: string; index: string; indexSha: string; hash: string; keys: Set<string> }

/** A file path is "dirty" when its iecode: view or its raw file: document has unsaved edits. */
const isDirty = (fsPath: string) => vscode.workspace.textDocuments.some(d =>
  d.isDirty && (d.uri.scheme === SCHEME || d.uri.scheme === 'file') && d.uri.fsPath.toLowerCase() === fsPath.toLowerCase());

const nodeIo: SafeWriteIo = {
  write: (p, c) => fsp.writeFile(p, c),
  rename: (a, b) => fsp.rename(a, b),
  remove: p => fsp.rm(p, { force: true }),
};

type Guard = (i: GuardInput) => { ok: true } | { ok: false; message: string; wholeFile?: boolean };

/** Reads everything staging (or discarding) needs and applies the guard. A refusal carries its message. */
async function snapshot(file: vscode.Uri, guard: Guard = stageGuard): Promise<{ ok: true; s: Snapshot } | { ok: false; message: string; wholeFile?: boolean }> {
  const root = await repoRoot(file.fsPath);
  if (!root) return { ok: false, message: 'The file is not in a git repository' };
  const entry = await indexEntry(root, file.fsPath);
  const conflict = await indexHasConflict(root, file.fsPath);
  let index: string | undefined, utf8 = true;
  try { index = await readIndex(root, file.fsPath); } catch (e) { if (e instanceof NotUtf8Error) utf8 = false; else throw e; }
  const bytes = await vscode.workspace.fs.readFile(file);
  const decoded = decodeUtf8Strict(bytes);    // TextDecoder would drop a BOM and make every BOM file look invalid
  if (decoded === undefined) utf8 = false;
  const work = decoded ?? '';
  let decodes = true;
  try { decode(work.replace(/^﻿/, '')); if (index) decode(index.replace(/^﻿/, '')); } catch { decodes = false; }
  const g = guard({
    tracked: !!entry && entry.stage === 0 || conflict, intentToAdd: index === '', conflict, decodes, dirty: isDirty(file.fsPath),
    mixedEol: !!index && hasMixedEol(index), utf8,
  });
  if (!g.ok) return g;
  const keys = new Set(changedSections(index!, work).map(c => c.key));
  return { ok: true, s: { root, file, work, index: index!, indexSha: entry!.sha, hash: sha(work), keys } };
}

export function registerObjectStage(ctx: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const refresh = () => changed.fire();

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(doc) {
      if (!vscode.workspace.getConfiguration('iecode').get<boolean>('stage.codeLens', true)) return [];
      const file = doc.uri.with({ scheme: 'file' });
      try {
        const r = await snapshot(file);
        if (!r.ok || !r.s.keys.size) return [];
        const heads = new Map(outline(doc.getText()).map(h => [`${h.kind}:${h.name}`, h.line]));
        heads.set('MAIN', 0);
        return [...r.s.keys].filter(k => heads.has(k)).map(k => {
          const line = heads.get(k)!;
          return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: 'Stage Method', command: 'iecode.stageSection', arguments: [doc.uri, k, r.s.hash],
            tooltip: `Stage only ${k.replace(':', ' ')} of this file`,
          });
        }).concat([...r.s.keys].filter(k => heads.has(k)).map(k => {
          const line = heads.get(k)!;
          return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: 'Discard Method', command: 'iecode.discardSection', arguments: [doc.uri, k, r.s.hash],
            tooltip: `Restore ${k.replace(':', ' ')} from the index and drop your changes to it`,
          });
        }));
      } catch { return []; }
    },
  };

  ctx.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, lenses),
    vscode.commands.registerCommand('iecode.stageSection', async (uri: vscode.Uri, key: string, hash?: string) => {
      if (!uri || !key) return;                  // not declared in package.json, so a keybinding or task may call it bare
      const file = uri.with({ scheme: 'file' });
      try {
        const r = await snapshot(file);
        if (!r.ok) {
          const choice = r.wholeFile ? await vscode.window.showWarningMessage(`IECode: ${r.message}`, 'Stage whole file') : (void vscode.window.showWarningMessage(`IECode: ${r.message}`), undefined);
          if (choice) await vscode.commands.executeCommand('git.stage', file);
          return;
        }
        if (hash && hash !== r.s.hash) { vscode.window.showWarningMessage('IECode: the file changed on disk, try again'); refresh(); return; }
        if (!r.s.keys.has(key)) { vscode.window.showInformationMessage('IECode: nothing to stage for this section'); refresh(); return; }
        const next = stageSection(r.s.index, r.s.work, key);
        await writeIndexBlob(r.s.root, file.fsPath, next, r.s.indexSha);
        await vscode.commands.executeCommand('git.refresh').then(undefined, () => undefined);
        refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`IECode: staging failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('iecode.discardSection', async (uri: vscode.Uri, key: string, hash?: string) => {
      if (!uri || !key) return;                  // not declared in package.json, so a keybinding or task may call it bare
      const file = uri.with({ scheme: 'file' });
      try {
        const r = await snapshot(file, discardGuard);
        if (!r.ok) { vscode.window.showWarningMessage(`IECode: ${r.message}`); return; }
        if (hash && hash !== r.s.hash) { vscode.window.showWarningMessage('IECode: the file changed on disk, try again'); refresh(); return; }
        if (!r.s.keys.has(key)) { vscode.window.showInformationMessage('IECode: nothing to discard for this section'); refresh(); return; }
        const name = file.fsPath.split(/[\\/]/).pop() ?? file.fsPath;
        const answer = await vscode.window.showWarningMessage(discardConfirmText(key, name), { modal: true }, 'Discard');
        if (answer !== 'Discard') return;
        // the modal can stay open for minutes: read everything again, with a fresh dirty state of both documents
        const again = await snapshot(file, discardGuard);
        if (!again.ok) { vscode.window.showWarningMessage(`IECode: ${again.message}`); return; }
        if (again.s.hash !== r.s.hash) { vscode.window.showWarningMessage('IECode: the file changed on disk, try again'); refresh(); return; }
        const next = discardSection(again.s.index, again.s.work, key);
        await writeFileSafe(file.fsPath, Buffer.from(next, 'utf8'), nodeIo);
        await vscode.commands.executeCommand('git.refresh').then(undefined, () => undefined);
        refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`IECode: discarding failed: ${(e as Error).message}`);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.stage')) refresh(); }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
  ctx.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  // the index changes outside the file system watcher's reach of the object files; the SCM view refresh covers most cases
  const idx = vscode.workspace.createFileSystemWatcher('**/.git/index');
  ctx.subscriptions.push(idx, idx.onDidChange(refresh));
}
