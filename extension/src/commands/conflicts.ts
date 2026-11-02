// Conflict bar for TwinCAT object files in a git merge conflict: auto-resolve the XML (merge of the ST views of
// git's index stages), open VS Code's XML merge editor, or open the file as XML.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CONFLICT_RE } from '../model';
import { repoRoot, mergeLabels } from '../core/git';
import { autoResolve, AutoResolveError, editedSinceConflict, sameSnapshot, snapshotOf } from '../core/autoResolve';

const SCHEME = 'iecode';
const EXT_RE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;
const NOT_OBJECT = 'IECode: auto-resolve works on .TcPOU/.TcDUT/.TcGVL/.TcIO files.';

/** The file: Uri a command was invoked on (editor, Source Control, tree node, active editor); the ST view maps to its file. */
export function targetUri(arg: unknown): vscode.Uri | undefined {
  const a = arg as { resourceUri?: vscode.Uri; obj?: { file: string } } | undefined;
  const u = arg instanceof vscode.Uri ? arg
    : a?.resourceUri ?? (a?.obj?.file ? vscode.Uri.file(a.obj.file) : vscode.window.activeTextEditor?.document.uri);
  return u?.scheme === SCHEME ? u.with({ scheme: 'file' }) : u;
}

/** Open text documents of the file (XML or ST view). */
const documentsOf = (file: vscode.Uri) => vscode.workspace.textDocuments
  .filter(d => (d.uri.scheme === 'file' || d.uri.scheme === SCHEME) && d.uri.fsPath === file.fsPath);

async function autoResolveXml(arg: unknown) {
  const uri = targetUri(arg);
  if (!uri) return;
  if (uri.scheme !== 'file' || !EXT_RE.test(uri.path)) return void vscode.window.showInformationMessage(NOT_OBJECT);
  const file = uri.fsPath;
  const name = path.basename(file);
  try {
    const res = await autoResolve(file);
    // rebuilding from git's stages discards hand edits: unsaved ones in an editor or saved ones in the file
    const dirty = documentsOf(uri).filter(d => d.isDirty);
    const edited = dirty.length > 0 ||
      await editedSinceConflict(file, res.snapshot, await mergeLabels((await repoRoot(file))!), res.snapshot.working);
    if (edited && await vscode.window.showWarningMessage(`Overwrite your edits in ${name}?`, { modal: true }, 'Overwrite') !== 'Overwrite') return;
    // the user or git may have changed the file or the index while the prompt was open
    if (!sameSnapshot(res.snapshot, await snapshotOf(file))) {
      return void vscode.window.showWarningMessage(`${name} changed meanwhile; run Auto-resolve again.`);
    }
    await fs.writeFile(file, res.xml, 'utf8');
    // dirty editors would otherwise save their stale text over the result
    for (const d of dirty) {
      await vscode.window.showTextDocument(d);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('iecode.openAsST', uri);
    void vscode.window.showInformationMessage(res.codeConflicts === 0
      ? `${name}: merged. Stage it in Source Control.`
      : `${name}: XML merged (ours wins). ${res.codeConflicts} code conflict(s) left in the ST view.`);
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof AutoResolveError ? e.message : `${name}: auto-resolve failed: ${(e as Error).message}`);
  }
}

export function register(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.autoResolveXml', autoResolveXml),
    vscode.commands.registerCommand('iecode.openMergeEditor', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri) await vscode.commands.executeCommand('git.openMergeEditor', uri);
    }),
  );

  // Context key for the editor title bar: open object files that contain a conflict marker (XML or ST code).
  // `resourcePath` is the fsPath of the editor's Uri, so list each file as file: and as iecode: (ST view).
  let generation = 0;
  const refresh = async () => {
    const run = ++generation;
    const files = new Map<string, vscode.Uri>();
    for (const t of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
      const u = t.input instanceof vscode.TabInputText ? t.input.uri : undefined;
      if (u && (u.scheme === 'file' || u.scheme === SCHEME) && EXT_RE.test(u.path)) files.set(u.fsPath, vscode.Uri.file(u.fsPath));
    }
    const hits = await Promise.all([...files.values()].map(async f =>
      CONFLICT_RE.test(await fs.readFile(f.fsPath, 'utf8').catch(() => '')) ? [f.fsPath, f.with({ scheme: SCHEME }).fsPath] : []));
    if (run === generation) await vscode.commands.executeCommand('setContext', 'iecode.conflictedFiles', [...new Set(hits.flat())]);
  };
  // a merge or checkout changes many files at once
  let timer: NodeJS.Timeout | undefined;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 200); };
  const w = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
  ctx.subscriptions.push(w, w.onDidChange(later), w.onDidCreate(later), w.onDidDelete(later),
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
    new vscode.Disposable(() => clearTimeout(timer)));
  void refresh();
}
