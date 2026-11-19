// Impact view: which tasks, callers and IO links a change to an object, member or variable touches.

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { AnalysisState } from '../core/analysisState';
import { ImpactRow, impactOf, impactRows } from '../core/impact';
import { IoLink, toIoLink } from '../core/iolinks';
import { parsePlcLinkSide, systemProjectOf } from '../core/ioLinkSymbols';
import { readProject } from '../core/iotree';
import { emptyReason } from '../core/unusedView';
import { Unit, systemProjects, unitOfFile } from '../core/workspace';
import { LanguageApi } from '../lang/providers';
import { WorkspaceState } from '../state';
import type { Node } from '../views/tree';

const SCHEME = 'iecode';
const OBJECT_KINDS = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'STRUCT', 'UNION', 'ENUM', 'ALIAS', 'GVL']);
const MEMBER_KINDS = new Set(['METHOD', 'PROPERTY', 'ACTION', 'TRANSITION']);

interface Target { unit: Unit; id: string; label: string; variable?: string }

/** The links of the system project that contains the PLC, plus those of separate system-only projects that name this PLC; undefined when none could be read. */
async function linksOf(state: WorkspaceState, unit: Unit): Promise<{ links?: IoLink[]; plcName: string; tsproj?: string }> {
  const own = systemProjectOf(state.current, unit);
  const plcName = own?.plcName ?? unit.plc.itemName ?? unit.plc.name;
  const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);
  const files = [...(own ? [own.project.file] : []), ...systemProjects(state.current).filter(s => s.solution === unit.solution).map(s => s.project.file)];
  let links: IoLink[] | undefined;
  for (const f of files) {
    try {
      const mine = (await readProject(f, read)).links.map(toIoLink)
        .filter(l => f === own?.project.file || parsePlcLinkSide(l.variable)?.plc.toLowerCase() === plcName.toLowerCase());
      links = [...(links ?? []), ...mine];
    } catch { /* an unreadable project: the links stay as far as they were read */ }
  }
  return { links: own || links ? links : undefined, plcName, tsproj: own?.project.file };
}

async function targetOf(arg: unknown, state: WorkspaceState, lang: LanguageApi): Promise<Target | undefined> {
  const node = arg as Node | undefined;
  if (node && typeof node === 'object' && 'kind' in node) {
    if (node.kind === 'object') return { unit: node.unit, id: node.obj.name.toUpperCase(), label: node.obj.name };
    if (node.kind === 'member') return { unit: node.unit, id: `${node.obj.name}.${node.member.name}`.toUpperCase(), label: `${node.obj.name}.${node.member.name}` };
    return undefined;
  }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== SCHEME) return undefined;
  const file = ed.document.uri.with({ scheme: 'file' }).fsPath;
  const unit = unitOfFile(state.current, file);
  if (!unit) return undefined;
  await lang.ready();
  const loc = lang.index.resolve(file, ed.selection.active.line, ed.selection.active.character);
  if (!loc) return undefined;
  const { symbol, owner } = loc;
  if (OBJECT_KINDS.has(symbol.kind)) return { unit, id: symbol.name.toUpperCase(), label: symbol.name };
  if (owner && MEMBER_KINDS.has(symbol.kind)) return { unit, id: `${owner.name}.${symbol.name}`.toUpperCase(), label: `${owner.name}.${symbol.name}` };
  if (owner) return { unit, id: owner.name.toUpperCase(), label: `${owner.name}.${symbol.name}`, variable: `${owner.name}.${symbol.name}` };
  return undefined;
}

export function registerImpact(ctx: vscode.ExtensionContext, analysis: AnalysisState, state: WorkspaceState, lang: LanguageApi): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.showImpact', async (arg?: unknown) => {
    const t = await targetOf(arg, state, lang);
    if (!t) { vscode.window.showInformationMessage('IECode: select an object or member in the project tree, or put the cursor on a name in an ST view.'); return; }
    const a = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Analysing ${t.unit.id}` }, () => analysis.request(t.unit.id));
    if (!a.graph.nodes.has(t.id)) { vscode.window.showInformationMessage(`IECode: ${t.label} is not in the analysis of ${t.unit.id}.`); return; }
    const io = await linksOf(state, t.unit);
    const result = impactOf(a.graph, a.reach, [...new Set(a.roots.filter(r => r.why === 'task').map(r => r.id))], t.id, io.links, io.plcName, t.variable);
    const why = emptyReason(a);
    if (why && a.skipped !== 'no-tasks') result.notes.unshift(why);

    const rows = impactRows(a.graph, result);
    const items = [
      ...rows.filter(r => r.kind === 'note').map(r => ({ label: `$(info) ${r.label}`, row: r })),
      ...rows.filter(r => r.kind !== 'note').map(r => ({
        label: `${{ task: '$(play)', caller: '$(symbol-method)', io: '$(plug)', note: '' }[r.kind]} ${r.label}`, description: r.detail, row: r,
      })),
    ];
    const summary = `${t.label}: ${result.tasks.length} task(s), ${result.directCallers.length} direct and ${result.transitiveCallers} further caller(s), ${result.ioLinks.length} IO link(s)`;
    const pick = await vscode.window.showQuickPick<{ label: string; description?: string; row: ImpactRow }>(items, { title: 'Impact', placeHolder: summary });
    const row = pick?.row;
    if (!row) return;
    if (row.kind === 'io') {
      if (io.tsproj) await vscode.commands.executeCommand('iecode.ioLinks', { kind: 'system', project: { file: io.tsproj } });
    } else if (row.target) {
      const at = new vscode.Position(row.target.line, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(row.target.file).with({ scheme: SCHEME }), { selection: new vscode.Range(at, at) });
    }
  }));
}
