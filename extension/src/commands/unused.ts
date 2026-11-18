// Unused objects: a mark in the project tree, a faded hint in the ST view and a list command.
// The tree and the hints only peek at the analysis; this module starts the computation (debounced) when it is switched on.

import * as vscode from 'vscode';
import { AnalysisState } from '../core/analysisState';
import { UnusedMarks, emptyReason, unusedMarks } from '../core/unusedView';
import { WorkspaceState } from '../state';
import { Unit, unitOfFile } from '../core/workspace';

const SCHEME = 'iecode';
const enabled = () => vscode.workspace.getConfiguration('iecode.analysis').get<boolean>('markUnused', true);

export function registerUnused(ctx: vscode.ExtensionContext, analysis: AnalysisState, state: WorkspaceState): UnusedMarks {
  const marks = new UnusedMarks(analysis, enabled);
  const hints = vscode.languages.createDiagnosticCollection('iecode-unused');

  const dirty = (doc: vscode.TextDocument) => vscode.workspace.textDocuments.some(d =>
    d.isDirty && (d.uri.scheme === SCHEME || d.uri.scheme === 'file') && d.uri.fsPath.toLowerCase() === doc.uri.fsPath.toLowerCase());

  /** One Hint with the Unnecessary tag per mark of the file; none while the document has unsaved edits (positions would be stale). */
  const publish = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== SCHEME) return;
    const file = doc.uri.with({ scheme: 'file' }).fsPath;
    const unit = unitOfFile(state.current, file);
    if (!unit || !enabled() || dirty(doc)) { hints.delete(doc.uri); return; }
    marks.ensure(unit.id);
    const list = [...marks.marksByFileOf(unit.id)].find(([f]) => f.toLowerCase() === file.toLowerCase())?.[1] ?? [];
    hints.set(doc.uri, list.map(m => {
      const d = new vscode.Diagnostic(new vscode.Range(m.line, m.col, m.line, m.col + m.name.length), `${m.name}: ${m.text}`, vscode.DiagnosticSeverity.Hint);
      d.tags = [vscode.DiagnosticTag.Unnecessary];
      d.source = 'IECode';
      return d;
    }));
  };
  const publishAll = () => vscode.workspace.textDocuments.forEach(publish);

  ctx.subscriptions.push(
    marks, hints,
    analysis.onDidChange(publishAll),
    vscode.workspace.onDidOpenTextDocument(publish),
    vscode.workspace.onDidSaveTextDocument(d => setTimeout(() => publish(d), 0)),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.uri.scheme === SCHEME && e.contentChanges.length) hints.delete(e.document.uri); }),
    vscode.workspace.onDidCloseTextDocument(d => hints.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.analysis.markUnused')) publishAll(); }),

    vscode.commands.registerCommand('iecode.showUnused', async (arg?: { kind?: string; unit?: Unit }) => {
      let unit: Unit | undefined = arg?.kind === 'unit' ? arg.unit : undefined;
      if (!unit) {
        const active = vscode.window.activeTextEditor?.document.uri;
        unit = active ? unitOfFile(state.current, active.with({ scheme: 'file' }).fsPath) : undefined;
      }
      if (!unit) {
        const apps = state.current.units.filter(u => !u.plc.isLibrary);
        if (apps.length === 1) unit = apps[0];
        else if (apps.length > 1) {
          const pick = await vscode.window.showQuickPick(apps.map(u => ({ label: u.id, unit: u })), { placeHolder: 'PLC project' });
          unit = pick?.unit;
        }
      }
      if (!unit) { vscode.window.showInformationMessage('IECode: no PLC project found.'); return; }
      const u = unit;
      const a = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Analysing ${u.id}` }, () => analysis.request(u.id));
      const reason = emptyReason(a);
      if (reason) { vscode.window.showInformationMessage(`IECode: ${u.id}: ${reason}`); return; }
      const list = unusedMarks(a);
      if (!list.length) { vscode.window.showInformationMessage(`IECode: nothing in ${u.id} is unused.`); return; }
      const pick = await vscode.window.showQuickPick(list.map(m => ({
        label: m.name, description: m.text, detail: vscode.workspace.asRelativePath(m.file), mark: m,
      })), { placeHolder: `${list.length} unused in ${u.id}`, matchOnDetail: true });
      if (!pick) return;
      const at = new vscode.Position(pick.mark.line, pick.mark.col);
      await vscode.window.showTextDocument(vscode.Uri.file(pick.mark.file).with({ scheme: SCHEME }), { selection: new vscode.Range(at, at) });
    }),
  );
  return marks;
}
