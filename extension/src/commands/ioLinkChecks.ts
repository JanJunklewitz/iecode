// IO link checks in the Problems panel (on the .tsproj / .xti that stores each link) and as a "Checks" group in the IO links view.
// Every run replaces the diagnostics of the collection, so a fresh source turns old dead-link findings into one io-not-built info.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTmc } from '../core/adsinterface';
import { Finding, Level, applyLevels, summaryText } from '../core/findings';
import { IO_RULES, checkIoLinks, ioFindingRows, withLines } from '../core/ioLinkChecks';
import { readProject } from '../core/iotree';
import { newerSources } from '../core/symbolOrigin';
import { decodeTmc, parseTmc } from '../core/tmc';
import { TwinCatProject } from '../core/projects';
import { WorkspaceState } from '../state';
import { ioLinksShown, setIoChecks } from '../views/ioLinks';

const SOURCE = 'IECode';
const DEFAULTS: Record<string, Level | 'off'> = Object.fromEntries(IO_RULES.map(r => [r.id, r.level]));
const SEVERITY: Record<Level, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint,
};
const cfg = () => vscode.workspace.getConfiguration('iecode.lint');
const enabled = () => cfg().get<boolean>('enabled', true);
const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);

/** Findings of every PLC project of one system project; file paths are made absolute. */
async function checkProject(project: TwinCatProject): Promise<{ findings: Finding[]; note?: string }> {
  const dir = path.dirname(project.file);
  const snap = await readProject(project.file, read);
  const texts = new Map<string, string>();
  for (const f of new Set(snap.links.map(l => l.file))) { const t = await read(path.join(dir, f)); if (t !== undefined) texts.set(f, t); }
  const links = withLines(snap.links, f => texts.get(f));
  const incomplete = snap.warnings.length ? snap.warnings.join('; ') : undefined;
  const anchor = { file: path.basename(project.file), line: 0 };
  const out: Finding[] = [];

  for (const plc of project.plcs) {
    const tmcFile = await findTmc(plc.file);
    let tmc, stale = false, unreadable: string | undefined;
    if (tmcFile) {
      try {
        tmc = parseTmc(decodeTmc(await fs.readFile(tmcFile)));
        const built = (await fs.stat(tmcFile)).mtimeMs;
        const sources = await Promise.all([plc.file, ...plc.objects.map(o => o.file)].map(async file => ({ file, mtimeMs: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0 })));
        stale = newerSources(built, sources).length > 0;
      } catch (e) { tmc = undefined; unreadable = (e as Error).message; }   // a half-written or corrupt .tmc is not "not built"
    }
    out.push(...checkIoLinks(links, tmc, { stale, unreadable }, plc.itemName ?? plc.name, { anchor, incomplete }));
  }
  return { findings: out.map(f => ({ ...f, file: path.resolve(dir, f.file) })) };
}

export function registerIoLinkChecks(ctx: vscode.ExtensionContext, state: WorkspaceState): void {
  const diags = vscode.languages.createDiagnosticCollection('iecode-lint-iolinks');
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<Finding[]> | undefined;
  let again = false;
  let published = new Set<string>();
  ctx.subscriptions.push(diags, { dispose: () => clearTimeout(timer) });

  const systemProjects = () => [...new Map(state.current.solutions.flatMap(s => s.projects).filter(p => !p.plcOnly && p.plcs.length).map(p => [p.file, p])).values()];

  const run = async (): Promise<Finding[]> => {
    if (!enabled()) { diags.clear(); systemProjects().forEach(p => setIoChecks(p.file, [])); return []; }
    const overrides = cfg().get<Record<string, Level | 'off'>>('rules', {});
    const all: Finding[] = [];
    for (const p of systemProjects()) {
      let found: Finding[];
      try { found = applyLevels((await checkProject(p)).findings, overrides, DEFAULTS); }
      catch (e) {
        // an empty result would look like "all links are fine": say that the check failed
        console.warn(`IECode: IO link checks of ${p.file}: ${(e as Error).message}`);
        found = [{ rule: 'io-links-incomplete', level: 'info', message: `IO link checks failed: ${(e as Error).message}`, file: p.file, space: 'xml', line: 0, col: 0, endLine: 0, endCol: 1 }];
      }
      setIoChecks(p.file, ioFindingRows(found));
      all.push(...found);
    }
    const byFile = new Map<string, Finding[]>();
    for (const f of all) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    // replace in one go: no empty Problems panel while the run is in progress
    for (const u of published) if (!byFile.has(u)) diags.delete(vscode.Uri.file(u));
    published = new Set(byFile.keys());
    for (const [file, list] of byFile) diags.set(vscode.Uri.file(file), list.map(f => {
      const d = new vscode.Diagnostic(new vscode.Range(f.line, f.col, f.endLine, f.endCol), f.message, SEVERITY[f.level]);
      d.source = SOURCE;
      d.code = f.rule;
      return d;
    }));
    return all;
  };

  /** One run at a time; a request that arrives during a run triggers one more when it ends. */
  const request = (): Promise<Finding[]> => {
    if (running) { again = true; return running; }
    running = run().finally(() => { running = undefined; if (again) { again = false; schedule(0); } });
    return running;
  };
  const schedule = (delay = 1000) => { clearTimeout(timer); timer = setTimeout(() => void request().catch(e => console.warn(`IECode: ${(e as Error).message}`)), delay); };

  const relevant = (p: string) => /\.(tsproj|xti|tmc|plcproj|TcPOU|TcDUT|TcGVL|TcIO)$/i.test(p);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tmc,tsproj,xti}');
  ctx.subscriptions.push(
    watcher, watcher.onDidChange(() => schedule()), watcher.onDidCreate(() => schedule()), watcher.onDidDelete(() => schedule()),
    vscode.workspace.onDidSaveTextDocument(d => { if (relevant(d.uri.fsPath)) schedule(); }),
    ioLinksShown.event(() => schedule(0)),
    state.onDidChange(() => schedule(2000)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.lint')) schedule(0); }),
    vscode.commands.registerCommand('iecode.lintIoLinks', async () => {
      if (!enabled()) { void vscode.window.showInformationMessage('IECode: lint is off (iecode.lint.enabled).'); return; }
      if (!systemProjects().length) { void vscode.window.showInformationMessage('IECode: no TwinCAT system project with a PLC project found.'); return; }
      const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking IO links' }, () => request());
      void vscode.window.showInformationMessage(`IECode: IO links: ${summaryText(found)}`);
    }),
  );
  schedule(3000);
}
