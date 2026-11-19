// Export the project graph or the object graph as Mermaid text (clipboard or .mmd file).

import * as vscode from 'vscode';
import { AnalysisState } from '../core/analysisState';
import { MAX_NODES, mermaidNodeCount, objectGraphMermaid } from '../core/graphExport';
import { reach } from '../core/objectGraph';
import { emptyReason } from '../core/unusedView';
import { toMermaid as toProjectMermaid } from '../core/workspace';
import { WorkspaceState } from '../state';

async function deliver(text: string, name: string): Promise<void> {
  const how = await vscode.window.showQuickPick(['Copy', 'Save as .mmd'], { placeHolder: 'Mermaid export' });
  if (how === 'Copy') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('IECode: Mermaid graph copied.');
  } else if (how) {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: base && vscode.Uri.joinPath(base, `${name.replace(/[^\w.-]+/g, '_')}.mmd`),
      filters: { Mermaid: ['mmd'] },
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }
}

export function registerGraphExport(ctx: vscode.ExtensionContext, analysis: AnalysisState, state: WorkspaceState): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.exportGraphMermaid', async () => {
    const kind = await vscode.window.showQuickPick(['Project graph', 'Object graph'], { placeHolder: 'Which graph?' });
    if (!kind) return;
    if (kind === 'Project graph') {
      if (!state.current.units.length) { vscode.window.showInformationMessage('IECode: no PLC project found.'); return; }
      return deliver(toProjectMermaid(state.current), 'project-graph');
    }

    const apps = state.current.units.filter(u => !u.plc.isLibrary);
    const unit = apps.length === 1 ? apps[0] : (await vscode.window.showQuickPick(apps.map(u => ({ label: u.id, unit: u })), { placeHolder: 'PLC project' }))?.unit;
    if (!unit) { if (!apps.length) vscode.window.showInformationMessage('IECode: no application PLC project found.'); return; }
    const a = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Analysing ${unit.id}` }, () => analysis.request(unit.id));
    // unused marks only when the analysis can stand behind them
    const unused = emptyReason(a) ? undefined : a.unused;

    const whole = objectGraphMermaid(a.graph, { unused });
    const tasks = [...new Set(a.roots.filter(r => r.task).map(r => r.task!))];
    const scopes: { label: string; task?: string }[] = [];
    if (mermaidNodeCount(whole) <= MAX_NODES) scopes.push({ label: 'Whole project' });
    scopes.push(...tasks.map(t => ({ label: `Task ${t}`, task: t })));
    if (!scopes.length) { vscode.window.showInformationMessage(`IECode: ${unit.id} has more than ${MAX_NODES} objects and no task to export separately.`); return; }
    const scope = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { placeHolder: mermaidNodeCount(whole) > MAX_NODES ? `More than ${MAX_NODES} objects: export one task` : 'Scope' });
    if (!scope) return;

    let text = whole;
    if (scope.task) {
      const only = [...reach(a.graph, a.roots.filter(r => r.task === scope.task).map(r => r.id)).reachable.keys()];
      text = objectGraphMermaid(a.graph, { unused, only });
      if (mermaidNodeCount(text) > MAX_NODES) { vscode.window.showInformationMessage(`IECode: task ${scope.task} reaches more than ${MAX_NODES} objects; too large for one diagram.`); return; }
    }
    return deliver(text, `${unit.plc.name}${scope.task ? '-' + scope.task : ''}`);
  }));
}
