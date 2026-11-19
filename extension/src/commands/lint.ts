// Object lint: structure findings (raw XML, `file:` documents) and OOP findings (decoded ST view, `iecode:` documents)
// in the Problems panel, quick fixes for the safe ones, and "Lint Objects" for the whole workspace.
// A quick fix is recomputed against the current document text and refused when the text changed since the finding.

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { Finding, Level, applyLevels, summaryText, textVersion } from '../core/findings';
import { OOP_RULES, checkOop } from '../core/oopRules';
import { STRUCTURE_RULES, checkStructure } from '../core/structureRules';
import { buildUnitIndex } from '../core/unitIndex';
import { Unit, unitOfFile } from '../core/workspace';
import { LibrarySources } from '../lang/librarySources';
import { WorkspaceState } from '../state';

const SCHEME = 'iecode';
const SOURCE = 'IECode';
const OBJECT_FILE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;
const DEFAULTS: Record<string, Level | 'off'> = Object.fromEntries([...STRUCTURE_RULES, ...OOP_RULES].map(r => [r.id, r.level]));
const SEVERITY: Record<Level, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint,
};

const cfg = () => vscode.workspace.getConfiguration('iecode.lint');
const enabled = () => cfg().get<boolean>('enabled', true);
const levels = (fs_: Finding[]) => applyLevels(fs_, cfg().get<Record<string, Level | 'off'>>('rules', {}), DEFAULTS);
const isObjectFile = (p: string) => OBJECT_FILE.test(p);
const key = (p: string) => p.toLowerCase();

export function registerLint(ctx: vscode.ExtensionContext, state: WorkspaceState, libraries: LibrarySources): void {
  const diags = vscode.languages.createDiagnosticCollection('iecode-lint');
  /** Hash of the text each published URI was analysed from, and the URIs each unit's OOP run published. */
  const versions = new Map<string, string>();
  const oopUris = new Map<string, Set<string>>();
  const timers = new Map<string, NodeJS.Timeout>();
  ctx.subscriptions.push(diags, { dispose: () => timers.forEach(t => clearTimeout(t)) });

  const toDiagnostic = (f: Finding) => {
    const d = new vscode.Diagnostic(new vscode.Range(f.line, f.col, f.endLine, f.endCol), f.message, SEVERITY[f.level]);
    d.source = SOURCE;
    d.code = f.rule;
    return d;
  };
  const publish = (uri: vscode.Uri, found: Finding[]) => {
    versions.set(uri.toString(), found[0]?.version ?? '');
    diags.set(uri, found.map(toDiagnostic));
  };

  /** Text of a file as VS Code sees it: an open (possibly edited) XML document, else the disk. */
  const readXml = async (file: string) => {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && key(d.uri.fsPath) === key(file));
    return open ? open.getText() : fs.readFile(file, 'utf8').catch(() => undefined);
  };

  const lintFile = async (file: string): Promise<Finding[]> => {
    const uri = vscode.Uri.file(file);
    if (!enabled()) { diags.delete(uri); return []; }
    const text = await readXml(file);
    if (text === undefined) { diags.delete(uri); return []; }
    const found = levels(checkStructure(text, file, { namingPrefixes: cfg().get<Record<string, string>>('namingPrefixes', {}) }));
    found.length ? publish(uri, found) : (diags.delete(uri), versions.delete(uri.toString()));
    return found;
  };

  const unitIndexInput = {
    readFile: (f: string) => fs.readFile(f, 'utf8').catch(() => undefined),
    libraryObjects: (unit: Unit) => libraries.librariesOf(unit).flatMap(l => l.objects.flatMap(o => {
      const v = libraries.view(o.key);
      return v ? [{ key: o.key, view: v.text, library: v.library }] : [];
    })),
    namespaces: (unit: Unit) => {
      const m = new Map<string, string>();
      for (const r of unit.plc.references) { m.set(r.placeholder, r.effective.name); m.set(r.effective.name, r.effective.name); }
      for (const l of libraries.librariesOf(unit)) m.set(l.id.name, l.id.name);
      return m;
    },
  };

  /** OOP rules for every object of the unit: an object that instantiates or depends on a changed one is found as well. */
  const lintUnitOop = async (unit: Unit): Promise<Finding[]> => {
    for (const u of oopUris.get(unit.id) ?? []) diags.delete(vscode.Uri.parse(u));
    oopUris.delete(unit.id);
    if (!enabled()) return [];
    const { index } = await buildUnitIndex(unit, state.current, unitIndexInput, []);
    const all: Finding[] = [];
    const uris = new Set<string>();
    for (const o of unit.plc.objects) {
      const obj = index.get(o.file);
      if (!obj) continue;
      const found = levels(checkOop(index, obj));
      if (!found.length) continue;
      const uri = vscode.Uri.file(o.file).with({ scheme: SCHEME });
      publish(uri, found);
      uris.add(uri.toString());
      all.push(...found);
    }
    oopUris.set(unit.id, uris);
    return all;
  };

  const schedule = (file: string, delay = 400) => {
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      const unit = unitOfFile(state.current, file);
      void lintFile(file).then(() => unit && lintUnitOop(unit)).catch(e => console.warn(`IECode: lint ${file}: ${(e as Error).message}`));
    }, delay));
  };
  /** After a model reload or a settings change: the OOP rules of every unit again (structure findings follow open and save). */
  const scheduleAll = () => state.current.units.forEach(u => {
    clearTimeout(timers.get(u.id));
    timers.set(u.id, setTimeout(() => { timers.delete(u.id); void lintUnitOop(u).catch(e => console.warn(`IECode: lint ${u.id}: ${(e as Error).message}`)); }, 1500));
  });

  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(d => { if (isObjectFile(d.uri.fsPath)) schedule(d.uri.fsPath); }),
    vscode.workspace.onDidOpenTextDocument(d => { if (d.uri.scheme === 'file' && isObjectFile(d.uri.fsPath)) schedule(d.uri.fsPath, 0); }),
    // an edit makes the findings of that document stale until the next save
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length && e.document.uri.scheme === SCHEME && diags.has(e.document.uri)) diags.delete(e.document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('iecode.lint')) return;
      if (!enabled()) { diags.clear(); versions.clear(); oopUris.clear(); } else scheduleAll();
    }),
    state.onDidChange(scheduleAll),
  );
  vscode.workspace.textDocuments.forEach(d => { if (d.uri.scheme === 'file' && isObjectFile(d.uri.fsPath)) schedule(d.uri.fsPath, 0); });

  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.lintObjects', async () => {
    if (!enabled()) { void vscode.window.showInformationMessage('IECode: object lint is off (iecode.lint.enabled).'); return; }
    const units = state.current.units;
    if (!units.length) { void vscode.window.showInformationMessage('IECode: no PLC project found.'); return; }
    const all = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Linting objects' }, async progress => {
      const out: Finding[] = [];
      for (const [i, u] of units.entries()) {
        progress.report({ message: u.id, increment: 100 / units.length });
        for (const o of u.plc.objects) if (isObjectFile(o.file) && !o.encrypted) out.push(...await lintFile(o.file));
        out.push(...await lintUnitOop(u));
        if (i % 4 === 3) await new Promise(r => setImmediate(r));
      }
      return out;
    });
    void vscode.window.showInformationMessage(`IECode: ${summaryText(all)}`);
  }));

  // quick fixes exist for structure findings only, on the raw XML document
  ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file', pattern: '**/*.{TcPOU,TcDUT,TcGVL,TcIO}' }, {
    provideCodeActions(doc, _range, context) {
      const ours = context.diagnostics.filter(d => d.source === SOURCE && typeof d.code === 'string');
      if (!ours.length) return [];
      const text = doc.getText();
      // refuse when the document changed since the findings were published
      if (versions.get(doc.uri.toString()) !== textVersion(text)) return [];
      const current = checkStructure(text, doc.uri.fsPath);
      const actions: vscode.CodeAction[] = [];
      for (const d of ours) {
        const f = current.find(x => x.rule === d.code && x.fix && x.line === d.range.start.line && x.col === d.range.start.character);
        if (!f?.fix) continue;
        const a = new vscode.CodeAction(f.fix.title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, new vscode.Range(doc.positionAt(f.fix.edit.start), doc.positionAt(f.fix.edit.end)), f.fix.edit.text);
        actions.push(a);
      }
      return actions;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
}
