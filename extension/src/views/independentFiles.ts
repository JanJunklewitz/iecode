// Commands for the independent project files of a whole system project: save every inline box as its own .xti,
// and delete the .xti files nothing references any more. These work on one system project, picked from the node
// the command runs on or asked for. Save All Devices does the same for every system project of the workspace,
// listing each project in its confirmation (copies of a project in the workspace change too).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { findUnreferencedFiles, planSaveAllIndependent, SaveAllPlan, writeSaveAllPlan } from '../core/independentFiles';

type Project = { tsproj: string; name: string };

const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);
const MAX_LISTED = 25;

/** Lines for a modal's detail, cut after MAX_LISTED. */
function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  return shown.join('\n') + (items.length > shown.length ? `\n… and ${items.length - shown.length} more` : '');
}

/** The system project of the node a command runs on (Projects view `system`, IO-Link view `project` or `master`). */
function projectOfNode(n: unknown): Project | undefined {
  const x = n as { kind?: string; project?: { file?: string; tsproj?: string; name?: string } } | undefined;
  const p = x?.project;
  if (!p) return undefined;
  const tsproj = p.tsproj ?? p.file;
  return tsproj && p.name ? { tsproj, name: p.name } : undefined;
}

async function pickProject(state: WorkspaceState, n: unknown): Promise<Project | undefined> {
  const fromNode = projectOfNode(n);
  if (fromNode) return fromNode;
  const all = state.current.solutions.flatMap(s => s.projects.filter(p => !p.plcOnly)).map(p => ({ tsproj: p.file, name: p.name }));
  if (all.length <= 1) {
    if (!all.length) vscode.window.showInformationMessage('IECode: no TwinCAT system project (.tsproj) in the workspace.');
    return all[0];
  }
  const pick = await vscode.window.showQuickPick(all.map(p => ({ label: p.name, description: vscode.workspace.asRelativePath(p.tsproj), p })), { placeHolder: 'System project' });
  return pick?.p;
}

function dirtyAmong(files: string[]): string | undefined {
  const set = new Set(files.map(f => path.resolve(f).toLowerCase()));
  return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.isDirty && set.has(path.resolve(d.uri.fsPath).toLowerCase()))?.uri.fsPath;
}

async function saveAll(state: WorkspaceState, n: unknown): Promise<void> {
  const project = await pickProject(state, n);
  if (!project) return;
  const dir = path.dirname(project.tsproj);
  const rel = (f: string) => path.relative(dir, f);
  try {
    const plan = await planSaveAllIndependent(project.tsproj, read);
    if (!plan.created.length) {
      vscode.window.showInformationMessage(`IECode: every box of ${project.name} is already stored in its own file.`
        + (plan.skipped.length ? ` Skipped: ${plan.skipped.join('; ')}` : ''));
      return;
    }
    const dirty = dirtyAmong([...plan.changed, ...plan.created].map(c => c.file));
    if (dirty) throw new Error(`${path.basename(dirty)} has unsaved changes. Save or revert it first.`);
    const parts = [
      `${plan.created.length} box(es) move into their own .xti, ${plan.changed.length} existing file(s) change.`,
      plan.replaced.length && `These unreferenced files are overwritten:\n${listed(plan.replaced.map(rel))}`,
      plan.skipped.length && `Left as they are:\n${listed(plan.skipped)}`,
      'Close the project in TwinCAT XAE first, it would overwrite the change.',
    ].filter(Boolean);
    const pick = await vscode.window.showWarningMessage(`Save all boxes of ${project.name} as independent project files?`, { modal: true, detail: parts.join('\n\n') }, 'Save');
    if (pick !== 'Save') return;
    await writeSaveAllPlan(plan);
    vscode.window.showInformationMessage(`IECode: saved ${plan.created.length} independent project file(s) in ${project.name}.`);
  } catch (e) {
    vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
  }
}

/** Save All Boxes for every system project of the workspace, with one confirmation listing each project. */
async function saveAllEverywhere(state: WorkspaceState): Promise<void> {
  const projects = state.current.solutions.flatMap(s => s.projects.filter(p => !p.plcOnly)).map(p => ({ tsproj: p.file, name: p.name }));
  if (!projects.length) { vscode.window.showInformationMessage('IECode: no TwinCAT system project (.tsproj) in the workspace.'); return; }
  try {
    const plans: { project: Project; plan: SaveAllPlan }[] = [];
    const failed: string[] = [];
    for (const project of projects) {
      try { plans.push({ project, plan: await planSaveAllIndependent(project.tsproj, read) }); }
      catch (e) { failed.push(`${project.name} (${vscode.workspace.asRelativePath(project.tsproj)}): ${(e as Error).message}`); }
    }
    const todo = plans.filter(p => p.plan.created.length);
    if (!todo.length) {
      const msg = failed.length ? `nothing to save; failed: ${failed.join('; ')}` : 'every box of every system project is already stored in its own file.';
      (failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(`IECode: ${msg}`);
      return;
    }
    const dirty = dirtyAmong(todo.flatMap(p => [...p.plan.changed, ...p.plan.created].map(c => c.file)));
    if (dirty) throw new Error(`${path.basename(dirty)} has unsaved changes. Save or revert it first.`);
    const lines = todo.map(({ project, plan }) => `${project.name} (${vscode.workspace.asRelativePath(project.tsproj)}): ${plan.created.length} box(es)`
      + (plan.replaced.length ? `, overwrites ${plan.replaced.length} unreferenced file(s)` : '') + (plan.skipped.length ? `, leaves ${plan.skipped.length} item(s) as they are` : ''));
    const parts = [
      listed(lines),
      failed.length && `Not possible:\n${listed(failed)}`,
      'Every box moves into its own .xti next to its parent file, as TwinCAT does. Close the projects in TwinCAT XAE first, it would overwrite the change.',
    ].filter(Boolean);
    const total = todo.reduce((n, p) => n + p.plan.created.length, 0);
    const pick = await vscode.window.showWarningMessage(`Save all ${total} boxes of ${todo.length} system project(s) as independent project files?`, { modal: true, detail: parts.join('\n\n') }, 'Save');
    if (pick !== 'Save') return;
    for (const { plan } of todo) await writeSaveAllPlan(plan);
    vscode.window.showInformationMessage(`IECode: saved ${total} independent project file(s) in ${todo.length} system project(s).`);
  } catch (e) {
    vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
  }
}

async function deleteUnreferenced(state: WorkspaceState, n: unknown): Promise<void> {
  const project = await pickProject(state, n);
  if (!project) return;
  const dir = path.dirname(project.tsproj);
  try {
    const files = await findUnreferencedFiles(project.tsproj, read);
    if (!files.length) { vscode.window.showInformationMessage(`IECode: ${project.name} has no unreferenced project files.`); return; }
    const pick = await vscode.window.showWarningMessage(`Delete ${files.length} unreferenced project file(s) of ${project.name}?`, {
      modal: true,
      detail: listed(files.map(f => path.relative(dir, f))) + '\n\nNo item of the project references these files (.xti) or they are TwinCAT backups (.xti.bak). They go to the recycle bin.',
    }, 'Delete');
    if (pick !== 'Delete') return;
    for (const f of files) await vscode.workspace.fs.delete(vscode.Uri.file(f), { useTrash: true });
    vscode.window.showInformationMessage(`IECode: deleted ${files.length} unreferenced project file(s).`);
  } catch (e) {
    vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
  }
}

export function registerIndependentFileCommands(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.saveAllIndependent', (n?: unknown) => saveAll(state, n)),
    vscode.commands.registerCommand('iecode.saveAllIndependentEverywhere', () => saveAllEverywhere(state)),
    vscode.commands.registerCommand('iecode.deleteUnreferencedFiles', (n?: unknown) => deleteUnreferenced(state, n)),
  );
}
