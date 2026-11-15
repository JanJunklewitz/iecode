// .plcproj language support: underlines entries that don't match the files on disk (open editors and every
// PLC project of the workspace, in the Problems panel), quick fixes per entry, and "Resolve Project File",
// which repairs the whole file after a diff preview. The checks and edits are in core/projectCheck.ts.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { Node } from '../views/tree';
import {
  DiskTree, Issue, applyFix, checkProject, describeResolve, fixTitle, fixesFor, minimalEdit, resolveProject, scanProjectDir,
} from '../core/projectCheck';

const SOURCE = 'IECode';
const PREVIEW_SCHEME = 'iecode-plcproj-resolved';
const enabled = () => vscode.workspace.getConfiguration('iecode').get<boolean>('checkProjectFiles', true);
const isPlcproj = (u: vscode.Uri) => u.scheme === 'file' && /\.plcproj$/i.test(u.fsPath);
const key = (file: string) => path.resolve(file).toLowerCase();
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const openDoc = (file: string) => vscode.workspace.textDocuments.find(d => isPlcproj(d.uri) && key(d.uri.fsPath) === key(file));

/** offset → position for a text that is not open in an editor. */
function positions(text: string) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return new vscode.Position(lo, offset - starts[lo]);
  };
}

/** The project file a command was run on: tree node, URI (explorer / editor), the active editor, or a pick. */
async function targetFile(state: WorkspaceState, n?: Node | vscode.Uri): Promise<string | undefined> {
  if (n instanceof vscode.Uri) return n.fsPath;
  if (n && 'unit' in n) return n.unit.plc.file;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && isPlcproj(active)) return active.fsPath;
  const units = state.current.units;
  if (!units.length) { void vscode.window.showInformationMessage('IECode: no PLC project (.plcproj) in this workspace.'); return undefined; }
  if (units.length === 1) return units[0].plc.file;
  return (await vscode.window.showQuickPick(units.map(u => ({ label: u.id, description: u.group, file: u.plc.file })), { placeHolder: 'PLC project to resolve' }))?.file;
}

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const diags = vscode.languages.createDiagnosticCollection('iecode.plcproj');
  const disks = new Map<string, DiskTree>();
  const timers = new Map<string, NodeJS.Timeout>();
  ctx.subscriptions.push(diags, { dispose: () => timers.forEach(t => clearTimeout(t)) });

  /** The .plcproj files to check: the workspace's PLC projects and open .plcproj editors. */
  const projectFiles = () => {
    const m = new Map<string, string>();
    for (const u of state.current.units) m.set(key(u.plc.file), u.plc.file);
    for (const d of vscode.workspace.textDocuments) if (isPlcproj(d.uri)) m.set(key(d.uri.fsPath), d.uri.fsPath);
    return m;
  };

  const toDiagnostic = (uri: vscode.Uri, issue: Issue, pos: (o: number) => vscode.Position) => {
    const d = new vscode.Diagnostic(new vscode.Range(pos(issue.start), pos(issue.end)), issue.message,
      issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    d.source = SOURCE;
    d.code = issue.code;
    if (issue.first) d.relatedInformation = [new vscode.DiagnosticRelatedInformation(
      new vscode.Location(uri, new vscode.Range(pos(issue.first.valueStart), pos(issue.first.valueEnd))), 'First entry')];
    return d;
  };

  /** Checks one project file; `rescan` reads the folder again (else the last scan is reused, e.g. while typing). */
  const check = async (file: string, rescan = true) => {
    const uri = vscode.Uri.file(file);
    if (!enabled()) { diags.delete(uri); return; }
    let disk = disks.get(key(file));
    if (rescan || !disk) disks.set(key(file), disk = await scanProjectDir(path.dirname(file)));
    const doc = openDoc(file);
    const text = doc ? doc.getText() : await fs.readFile(file, 'utf8').then(stripBom, () => undefined);
    if (text === undefined) { diags.delete(uri); return; }
    const pos = doc ? (o: number) => doc.positionAt(o) : positions(text);
    try {
      diags.set(uri, checkProject(text, disk).map(i => toDiagnostic(uri, i, pos)));
    } catch (e) {
      const msg = (e as Error).message;
      const at = Number(/ at (\d+)/.exec(msg)?.[1] ?? 0);
      const d = new vscode.Diagnostic(new vscode.Range(pos(at), pos(at)), `The project file can't be read: ${msg}`, vscode.DiagnosticSeverity.Error);
      d.source = SOURCE;
      diags.set(uri, [d]);
    }
  };

  const schedule = (file: string, rescan = true, delay = 300) => {
    const k = key(file);
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); void check(file, rescan).catch(e => console.warn(`IECode: ${file}: ${(e as Error).message}`)); }, delay));
  };

  const checkAll = () => {
    const files = projectFiles();
    diags.forEach(uri => { if (!files.has(key(uri.fsPath))) diags.delete(uri); });
    for (const k of [...disks.keys()]) if (!files.has(k)) disks.delete(k);
    for (const f of files.values()) schedule(f);
  };

  /** A file or folder below a project folder was created or deleted (VS Code, git, TwinCAT …). */
  const onPathChanged = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    if (isPlcproj(uri)) { schedule(uri.fsPath); return; }
    const p = key(uri.fsPath);
    for (const f of projectFiles().values()) {
      const dir = key(path.dirname(f));
      if (!p.startsWith(dir + path.sep)) continue;
      const parts = p.slice(dir.length + 1).split(path.sep).slice(0, -1);
      if (!parts.some(d => d.startsWith('_') || d.startsWith('.'))) schedule(f);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  ctx.subscriptions.push(watcher,
    watcher.onDidCreate(onPathChanged), watcher.onDidDelete(onPathChanged),
    watcher.onDidChange(u => { if (isPlcproj(u) && !openDoc(u.fsPath)) schedule(u.fsPath); }),
    vscode.workspace.onDidRenameFiles(e => e.files.forEach(f => { onPathChanged(f.oldUri); onPathChanged(f.newUri); })),
    state.onDidChange(checkAll),
    vscode.workspace.onDidOpenTextDocument(d => { if (isPlcproj(d.uri)) schedule(d.uri.fsPath, true, 0); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (isPlcproj(e.document.uri) && e.contentChanges.length) schedule(e.document.uri.fsPath, false); }),
    vscode.workspace.onDidSaveTextDocument(d => { if (isPlcproj(d.uri)) schedule(d.uri.fsPath); }),
    vscode.workspace.onDidCloseTextDocument(d => { if (isPlcproj(d.uri)) checkAll(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.checkProjectFiles')) checkAll(); }),
  );
  checkAll();

  // ---------- quick fixes ----------

  ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file', pattern: '**/*.plcproj' }, {
    async provideCodeActions(doc, _range, context) {
      const ours = context.diagnostics.filter(d => d.source === SOURCE && typeof d.code === 'string');
      if (!ours.length) return [];
      const disk = disks.get(key(doc.uri.fsPath)) ?? await scanProjectDir(path.dirname(doc.uri.fsPath));
      const text = doc.getText();
      let issues: Issue[];
      try { issues = checkProject(text, disk); } catch { return []; }
      const actions: vscode.CodeAction[] = [];
      for (const d of ours) {
        const issue = issues.find(i => i.code === d.code && i.message === d.message && doc.positionAt(i.start).isEqual(d.range.start));
        if (!issue) continue;
        fixesFor(issue).forEach((fix, n) => {
          const e = minimalEdit(text, applyFix(text, issue, fix));
          const a = new vscode.CodeAction(fixTitle(issue, fix), vscode.CodeActionKind.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          a.edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
          a.diagnostics = [d];
          a.isPreferred = n === 0;
          actions.push(a);
        });
      }
      const all = new vscode.CodeAction('Resolve the whole project file…', vscode.CodeActionKind.QuickFix);
      all.command = { command: 'iecode.resolveProjectFile', title: all.title, arguments: [doc.uri] };
      all.diagnostics = ours;
      actions.push(all);
      return actions;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  // ---------- Resolve Project File ----------

  const previews = new Map<string, string>();
  const previewChanged = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(previewChanged, vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
    onDidChange: previewChanged.event,
    provideTextDocumentContent: u => previews.get(u.toString()) ?? '',
  }));
  const closePreview = async (uri: vscode.Uri) => {
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === uri.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    previews.delete(uri.toString());
  };

  /**
   * Repairs a project file in one go, after a summary and a diff preview. Returns the changes made (one line each),
   * or undefined when nothing was written. `apply: true` skips the confirmation (tests).
   */
  const resolve = async (n?: Node | vscode.Uri, opts?: { apply?: boolean }): Promise<string[] | undefined> => {
    const file = await targetFile(state, n);
    if (!file) return undefined;
    const name = path.basename(file);
    const read = async () => { const doc = openDoc(file); return doc ? doc.getText() : await fs.readFile(file, 'utf8'); };
    const before = await read();
    const disk = await scanProjectDir(path.dirname(file));
    let result;
    try { result = resolveProject(before, disk); } catch (e) {
      void vscode.window.showErrorMessage(`IECode: ${name} can't be read: ${(e as Error).message}`);
      return undefined;
    }
    const lines = describeResolve(result);
    if (!lines.length) {
      if (!opts?.apply) void vscode.window.showInformationMessage(`IECode: ${name} matches the files on disk; nothing to resolve.`);
      return [];
    }
    if (!opts?.apply) {
      const preview = vscode.Uri.file(file).with({ scheme: PREVIEW_SCHEME });
      previews.set(preview.toString(), result.text);
      previewChanged.fire(preview);
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(file), preview, `${name} ↔ Resolved`, { preview: true });
      const pick = await vscode.window.showInformationMessage(`Resolve ${name}? ${lines.length} change${lines.length === 1 ? '' : 's'}:`,
        { modal: true, detail: lines.join('\n') }, 'Apply');
      await closePreview(preview);
      if (pick !== 'Apply') return undefined;
    }
    if (await read() !== before) {
      void vscode.window.showWarningMessage(`IECode: ${name} changed in the meantime; run Resolve Project File again.`);
      return undefined;
    }
    const doc = openDoc(file);
    if (doc) {
      const wasDirty = doc.isDirty;
      const e = minimalEdit(before, result.text);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(`${name} could not be edited`);
      if (!wasDirty) await doc.save();
    } else {
      await fs.writeFile(file, result.text, 'utf8');
    }
    void state.reload();
    schedule(file, true, 0);
    if (!opts?.apply) void vscode.window.showInformationMessage(`IECode: ${name} resolved (${lines.length} change${lines.length === 1 ? '' : 's'}).`);
    return lines;
  };

  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.resolveProjectFile', (n?: Node | vscode.Uri, opts?: { apply?: boolean }) =>
    resolve(n, opts).catch(e => { void vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); return undefined; })));
}
