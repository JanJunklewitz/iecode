// Build, check, activate, save library, encrypt and workspace builds through the iecode CLI (Windows),
// plus the status bar and the mapping of compiler messages onto the plain-ST view.

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { Unit, affected, buildOrder, unitOfFile } from '../core/workspace';
import { CliDiagnostic, mapToView } from '../core/diagnostics';
import { decode } from '../model';
import { CliResult, cliAvailable, installCli, output, reportFailure, runCli } from '../cli/iecode';
import { Node } from '../views/tree';

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const diagnostics = vscode.languages.createDiagnosticCollection('iecode');
  const changed = new Set<string>();      // unit ids with saved changes since their last successful build
  ctx.subscriptions.push(diagnostics, output);

  // ------------------------------------------------------------ active project + status bar

  const memento = ctx.workspaceState;
  const activeUnit = (): Unit | undefined => {
    const units = state.current.units.filter(u => u.solution);
    const id = memento.get<string>('iecode.activeUnit');
    return units.find(u => u.id === id) ?? units.find(u => u.group === 'application') ?? units[0];
  };

  const projectItem = vscode.window.createStatusBarItem('iecode.project', vscode.StatusBarAlignment.Left, 50);
  projectItem.name = 'IECode: active project';
  projectItem.command = 'iecode.selectProject';
  const buildItem = vscode.window.createStatusBarItem('iecode.buildBtn', vscode.StatusBarAlignment.Left, 49);
  buildItem.name = 'IECode: build';
  buildItem.text = '$(play) Build';
  buildItem.command = 'iecode.build';
  const activateItem = vscode.window.createStatusBarItem('iecode.activateBtn', vscode.StatusBarAlignment.Left, 48);
  activateItem.name = 'IECode: activate';
  activateItem.text = '$(zap) Activate';
  activateItem.command = 'iecode.activate';
  ctx.subscriptions.push(projectItem, buildItem, activateItem);

  const updateStatus = () => {
    const u = activeUnit();
    if (!u) { projectItem.hide(); buildItem.hide(); activateItem.hide(); return; }
    const tc = vscode.workspace.getConfiguration('iecode').get<string>('tcVersion', 'auto');
    projectItem.text = `$(circuit-board) ${u.id} · ${tc === 'auto' ? (u.plc.tcVersion ?? 'TwinCAT') : 'TwinCAT ' + tc}`;
    projectItem.tooltip = `Active project for Build / Activate\n${u.solution?.file}\nClick to change`;
    projectItem.show();
    if (cliAvailable()) { buildItem.show(); if (u.group !== 'library') activateItem.show(); else activateItem.hide(); }
  };
  state.onDidChange(updateStatus);
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('iecode') && updateStatus()));
  vscode.commands.executeCommand('setContext', 'iecode.cliAvailable', cliAvailable());

  // Remember which units have changes, for "build affected".
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    const u = unitOfFile(state.current, doc.uri.with({ scheme: 'file' }).fsPath);
    if (u) changed.add(u.id);
  }));

  const unitFrom = (n?: Node): Unit | undefined => (n && 'unit' in n ? n.unit : activeUnit());
  const need = (u: Unit | undefined): u is Unit & { solution: NonNullable<Unit['solution']> } => {
    if (!cliAvailable()) { vscode.window.showWarningMessage('IECode: building and deploying needs Windows with TwinCAT XAE and the iecode CLI.'); return false; }
    if (!u) { vscode.window.showWarningMessage('IECode: no TwinCAT solution in this workspace.'); return false; }
    if (!u.solution) { vscode.window.showWarningMessage(`IECode: ${u.id} has no .sln; open it once in TwinCAT XAE to create one.`); return false; }
    return true;
  };

  // ------------------------------------------------------------ diagnostics

  async function publish(res: CliResult, sln: string) {
    const byUri = new Map<string, vscode.Diagnostic[]>();
    const add = (uri: vscode.Uri, d: vscode.Diagnostic) => {
      const k = uri.toString();
      byUri.set(k, [...(byUri.get(k) ?? []), d]);
    };
    for (const d of res.diagnostics) {
      const diag = (range: vscode.Range, section?: string) => {
        const x = new vscode.Diagnostic(range, d.message + (section && section !== 'MAIN' ? ` (${section})` : ''), SEVERITY[d.severity]);
        x.code = d.code;
        x.source = 'TwinCAT';
        return x;
      };
      if (d.file && /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i.test(d.file)) {
        try {
          const view = decode((await fs.readFile(d.file, 'utf8')).replace(/^﻿/, ''));
          const p = mapToView(view, path.basename(d.file).replace(/\.\w+$/, ''), d as CliDiagnostic);
          add(vscode.Uri.file(d.file).with({ scheme: 'iecode' }), diag(new vscode.Range(p.line, p.column, p.line, 999), p.section));
          continue;
        } catch { /* fall through to the raw file */ }
      }
      const line = Math.max(0, (d.line ?? 1) - 1);
      add(vscode.Uri.file(d.file ?? sln), diag(new vscode.Range(line, Math.max(0, (d.column ?? 1) - 1), line, 999)));
    }
    for (const [k, list] of byUri) diagnostics.set(vscode.Uri.parse(k), list);
  }

  type BuildData = { builds: { platform: string; ok: boolean; errors: number; warnings: number }[] };

  async function build(u: Unit & { solution: NonNullable<Unit['solution']> }, extra: string[] = []): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('iecode');
    const args = ['build', u.solution.file, ...cfg.get<string[]>('platforms', []).flatMap(p => ['-p', p]), ...extra];
    const res = await runCli<BuildData>(args, `Building ${u.id}`);
    diagnostics.clear();
    await publish(res, u.solution.file);
    const errors = res.diagnostics.filter(d => d.severity === 'error').length;
    const warnings = res.diagnostics.filter(d => d.severity === 'warning').length;
    if (res.ok) {
      changed.delete(u.id);
      vscode.window.setStatusBarMessage(`$(check) ${u.id}: build ok · ${warnings} warning(s)`, 8000);
    } else if (errors) {
      const pick = await vscode.window.showErrorMessage(`IECode: ${u.id} build failed with ${errors} error(s).`, 'Show Problems');
      if (pick) vscode.commands.executeCommand('workbench.actions.view.problems');
    } else {
      await reportFailure(res, 'Build');
    }
    return res.ok;
  }

  // ------------------------------------------------------------ commands

  const reg = (id: string, fn: (...a: never[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
      try { await fn(...args); }
      catch (e) { vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); }
    }));

  reg('iecode.selectProject', async () => {
    const units = state.current.units.filter(u => u.solution);
    const pick = await vscode.window.showQuickPick(units.map(u => ({ label: u.id, description: u.group, detail: u.solution!.file, u })), { title: 'Active project for Build / Activate' });
    if (!pick) return;
    await memento.update('iecode.activeUnit', pick.u.id);
    updateStatus();
  });

  reg('iecode.selectTcVersion', async () => {
    const cur = vscode.workspace.getConfiguration('iecode').get<string>('tcVersion', 'auto');
    const value = await vscode.window.showInputBox({
      title: 'TwinCAT version for build / activate', value: cur,
      prompt: 'auto, 4024, 4026, or an exact build like 4024.66',
      validateInput: v => /^(auto|(3\.1\.)?\d{4}(\.\d+)?)$/.test(v.trim()) ? undefined : 'auto, 4024, 4026 or e.g. 4024.66',
    });
    if (value) await vscode.workspace.getConfiguration('iecode').update('tcVersion', value.trim(), vscode.ConfigurationTarget.Workspace);
  });

  reg('iecode.build', async (n?: Node) => { const u = unitFrom(n); if (need(u)) await build(u); });

  reg('iecode.check', async (n?: Node) => {
    const u = unitFrom(n);
    if (!need(u)) return;
    const res = await runCli(['check', u.solution.file], `Checking ${u.id}`);
    diagnostics.clear();
    await publish(res, u.solution.file);
    if (res.ok) vscode.window.setStatusBarMessage(`$(check) ${u.id}: check ok`, 8000);
    else if (!res.diagnostics.length) await reportFailure(res, 'Check');
  });

  reg('iecode.clean', async (n?: Node) => {
    const u = unitFrom(n);
    if (!need(u)) return;
    const res = await runCli(['clean', u.solution.file], `Cleaning ${u.id}`);
    if (!res.ok) await reportFailure(res, 'Clean');
  });

  reg('iecode.activate', async (n?: Node) => {
    const u = unitFrom(n);
    if (!need(u)) return;
    const cfg = vscode.workspace.getConfiguration('iecode');
    const known = cfg.get<string[]>('targets', []);
    const items: vscode.QuickPickItem[] = [{ label: 'local', description: 'this PC' }, ...known.map(t => ({ label: t })), { label: '$(add) Other target…', alwaysShow: true }];
    const pick = await vscode.window.showQuickPick(items, { title: `Activate ${u.id} on`, canPickMany: true });
    if (!pick?.length) return;
    let targets = pick.map(p => p.label).filter(l => !l.startsWith('$('));
    if (pick.some(p => p.label.startsWith('$('))) {
      const other = await vscode.window.showInputBox({ prompt: 'AMS NetId, e.g. 5.80.201.232.1.1', validateInput: v => /^(\d{1,3}\.){5}\d{1,3}$/.test(v.trim()) ? undefined : 'Six numbers separated by dots' });
      if (!other) return;
      targets.push(other.trim());
      if (!known.includes(other.trim())) await cfg.update('targets', [...known, other.trim()], vscode.ConfigurationTarget.Workspace);
    }
    targets = [...new Set(targets)];
    const restart = cfg.get<boolean>('restartAfterActivate', true);
    const ok = await vscode.window.showWarningMessage(
      `Activate ${u.id} on ${targets.join(', ')}${restart ? ' and restart TwinCAT in run mode' : ''}?`, { modal: true }, 'Activate');
    if (ok !== 'Activate') return;
    const res = await runCli(['activate', u.solution.file, ...targets.flatMap(t => ['-t', t]), ...(restart ? [] : ['--no-restart']), '--yes'], `Activating ${u.id}`);
    await publish(res, u.solution.file);
    if (res.ok) vscode.window.showInformationMessage(`IECode: ${u.id} activated on ${targets.join(', ')}.`);
    else await reportFailure(res, 'Activation');
  });

  reg('iecode.libSave', async (n?: Node) => {
    const u = unitFrom(n);
    if (!need(u)) return;
    const mode = await vscode.window.showQuickPick([
      { label: '.library', description: 'with source', compiled: false },
      { label: '.compiled-library', description: 'without source', compiled: true },
    ], { title: `Save ${u.plc.title ?? u.plc.name} ${u.plc.version ?? ''} as` });
    if (!mode) return;
    const install = await vscode.window.showQuickPick(['Save and install', 'Save only'], { title: 'Install into the local library repository?' });
    if (!install) return;
    const out = path.join(path.dirname(u.solution.file), vscode.workspace.getConfiguration('iecode').get<string>('libraryOutput', 'dist'));
    const res = await runCli<{ file: string }>(['lib', 'save', u.solution.file, '--plc', u.plc.name, '-o', out,
      ...(mode.compiled ? ['--compiled'] : []), ...(install === 'Save and install' ? ['--install'] : [])], `Saving ${u.plc.title ?? u.plc.name}`);
    if (res.ok) {
      const pick = await vscode.window.showInformationMessage(`IECode: saved ${path.basename(res.data!.file)}.`, 'Reveal');
      if (pick) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.data!.file));
    } else await reportFailure(res, 'Save as library');
  });

  reg('iecode.libSaveAll', async () => {
    if (!cliAvailable()) return void vscode.window.showWarningMessage('IECode: saving libraries needs Windows with TwinCAT XAE and the iecode CLI.');
    const units = state.current.units.filter(u => u.solution);
    if (!units.length) return void vscode.window.showInformationMessage('IECode: no PLC project with a solution in this workspace.');
    const scope = await vscode.window.showQuickPick([
      { label: 'All PLC projects', description: `${units.length}`, librariesOnly: false },
      { label: 'Library projects only', description: `${units.filter(u => u.plc.isLibrary).length} with Title, Company and Version`, librariesOnly: true },
    ], { title: 'Save all as library: which projects?' });
    if (!scope) return;
    const mode = await vscode.window.showQuickPick([
      { label: '.library', description: 'with source', compiled: false },
      { label: '.compiled-library', description: 'without source', compiled: true },
    ], { title: 'Save as' });
    if (!mode) return;
    const install = await vscode.window.showQuickPick(['Save and install', 'Save only'], { title: 'Install into the local library repository?' });
    if (!install) return;
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
      .filter(r => units.some(u => !path.relative(r, u.solution!.file).startsWith('..')));
    const outName = vscode.workspace.getConfiguration('iecode').get<string>('libraryOutput', 'dist');
    let saved = 0;
    for (const root of roots) {
      const res = await runCli<{ saved: number; failed: number }>(['lib', 'save-all', root,
        ...(scope.librariesOnly ? ['--libraries-only'] : []), ...(mode.compiled ? ['--compiled'] : []),
        ...(install === 'Save and install' ? ['--install'] : []), ...(outName === 'dist' ? [] : ['--dist', outName])],
        `Saving all as ${mode.label}`);
      saved += res.data?.saved ?? 0;
      if (!res.ok) return reportFailure(res, `Save all as library (${saved} saved)`);
    }
    vscode.window.showInformationMessage(`IECode: saved ${saved} project(s) as ${mode.label}.`);
  });

  reg('iecode.encrypt', async (n?: Node) => {
    const u = unitFrom(n);
    if (!need(u)) return;
    const mode = await vscode.window.showQuickPick([
      { label: 'Compiled library', detail: 'Save the PLC project as .compiled-library (no source)', id: 'compiled' },
      { label: 'Protect objects with a user database', detail: 'TwinCAT 3 Security Management: encrypt / sign files, set protection level', id: 'protect' },
    ], { title: `Encrypt ${u.id}` });
    if (!mode) return;
    if (mode.id === 'compiled') {
      const res = await runCli(['encrypt', u.solution.file, '--compiled-library', '--plc', u.plc.name], `Saving compiled library`);
      return res.ok ? vscode.window.showInformationMessage('IECode: compiled library saved.') : reportFailure(res, 'Encrypt');
    }
    const db = await vscode.window.showOpenDialog({ title: 'User database', filters: { 'TwinCAT user database': ['tcudb'] }, defaultUri: vscode.Uri.file(path.dirname(u.solution.file)) });
    if (!db?.[0]) return;
    const item = await vscode.window.showInputBox({ title: 'Tree item to protect', value: `TIPC^${u.plc.name}^${u.plc.name} Project`, prompt: 'TwinCAT tree path, separated by ^ (e.g. …^POUs for one folder)' });
    if (!item) return;
    const flags = await vscode.window.showQuickPick([{ label: 'encrypted', picked: true }, { label: 'signed', picked: true }], { title: 'File protection', canPickMany: true });
    if (!flags) return;
    const level = await vscode.window.showInputBox({ title: 'Protection level (optional)', prompt: 'Name of a protection level from the user database, e.g. Service' });
    if (level === undefined) return;
    const cred = await vscode.window.showInputBox({ title: 'Windows credential for the TwinCAT login (optional)', prompt: 'Credential Manager target name; leave empty if no login is needed' });
    if (cred === undefined) return;
    const spec = [item, `encrypted=${flags.some(f => f.label === 'encrypted')}`, `signed=${flags.some(f => f.label === 'signed')}`, ...(level ? [`level=${level}`] : [])].join(',');
    const ok = await vscode.window.showWarningMessage(`Protect ${item}? Afterwards only users of the user database can open these objects. Keep a backup.`, { modal: true }, 'Protect');
    if (ok !== 'Protect') return;
    const res = await runCli(['encrypt', u.solution.file, '--userdb', db[0].fsPath, '--protect', spec, '--yes', ...(cred ? ['--credential', cred] : [])], `Protecting ${u.id}`);
    if (res.ok) { vscode.window.showInformationMessage('IECode: protection applied.'); await state.reload(); }
    else await reportFailure(res, 'Protection');
  });

  /** Builds units in dependency order; libraries used through workspace links are saved + installed so dependents pick them up. */
  async function buildMany(ids: Set<string> | undefined, label: string) {
    if (!cliAvailable()) return void vscode.window.showWarningMessage('IECode: building needs Windows with TwinCAT XAE and the iecode CLI.');
    const m = state.current;
    const order = buildOrder(m, ids).map(id => m.units.find(u => u.id === id)!).filter(u => u.solution);
    if (!order.length) return void vscode.window.showInformationMessage(`IECode: nothing to build (${label}).`);
    output.show(true);
    output.appendLine(`Workspace build (${label}): ${order.map(u => u.id).join(' → ')}`);
    const built = new Set<string>();
    for (const u of order) {
      if (built.has(u.solution!.file)) continue;
      if (!await build(u as Unit & { solution: NonNullable<Unit['solution']> })) return;
      built.add(u.solution!.file);
      const usedByWorkspace = m.edges.some(e => e.to === u.id && e.link === 'workspace' && (!ids || ids.has(e.from)));
      if (u.plc.isLibrary && usedByWorkspace) {
        const res = await runCli(['lib', 'save', u.solution!.file, '--plc', u.plc.name, '--install', '-o', path.join(path.dirname(u.solution!.file), 'dist')], `Installing ${u.plc.title}`);
        if (!res.ok) return reportFailure(res, `Installing ${u.plc.title}`);
      }
    }
    vscode.window.showInformationMessage(`IECode: workspace build ok (${order.length} project(s)).`);
  }

  reg('iecode.installCli', async () => {
    const docs = 'https://github.com/JanJunklewitz/iecode/tree/main/cli#readme';
    if (!cliAvailable()) return void vscode.env.openExternal(vscode.Uri.parse(docs));
    const pick = await vscode.window.showInformationMessage(
      'Install the iecode CLI for your user from the latest GitHub release (downloads, checks SHA256, adds it to PATH)?',
      { modal: true }, 'Install', 'Open instructions');
    if (pick === 'Open instructions') return void vscode.env.openExternal(vscode.Uri.parse(docs));
    if (pick !== 'Install') return;
    if (await installCli()) vscode.window.showInformationMessage('IECode: CLI installed. Run "IECode: Set up this PC…" to check TwinCAT.');
    else vscode.window.showErrorMessage('IECode: installing the CLI failed. See the IECode output.');
  });

  reg('iecode.buildWorkspace', () => buildMany(undefined, 'all'));
  reg('iecode.buildAffected', () => {
    if (!changed.size) return vscode.window.showInformationMessage('IECode: no saved changes since the last build.');
    return buildMany(affected(state.current, [...changed]), 'affected');
  });
}
