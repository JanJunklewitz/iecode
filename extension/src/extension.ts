import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { decode, encode, outline, HEADER_RE, IMPL_RE, ViewError, ConflictError, CONFLICT_RE } from './model';
import { WorkspaceState } from './state';
import { ProjectTree } from './views/tree';
import { showGraph } from './views/graph';
import { showLibraryManager } from './views/libraryManager';
import type { Node } from './views/tree';
import * as objects from './commands/objects';
import * as engineering from './commands/engineering';
import * as language from './lang/providers';
import * as commentColor from './lang/commentColor';
import * as mergeConflicts from './lang/mergeConflicts';
import * as compare from './commands/compare';
import * as setup from './commands/setup';
import { owningProject, registerIoYaml, showIoLinks } from './views/ioLinks';
import { showAdsInterface } from './views/adsInterface';
import { registerIoLinkView } from './views/ioLinkTree';
import { isEncrypted } from './core/projects';
import { registerVisuEditor } from './views/visuEditor';
import { registerAiChat } from './commands/aiChat';
import { showProjectSettings } from './views/projectSettings';
import { registerPlcArchiveEditor } from './views/plcArchiveEditor';
import { SUMMARY_RE } from './core/plcArchive';
import { LIB_SCHEME, registerLibrarySources } from './lang/librarySources';

const SCHEME = 'iecode';
const LANG = 'twincat-st';
const EXT_RE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;

const toView = (file: vscode.Uri) => file.with({ scheme: SCHEME });
const toFile = (view: vscode.Uri) => view.with({ scheme: 'file' });

/** Virtual file system: iecode:/path/X.TcPOU shows the ST view of file:/path/X.TcPOU. */
class TcStFileSystem implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(ctx: vscode.ExtensionContext) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
    const fire = (type: vscode.FileChangeType) => (u: vscode.Uri) => this.emitter.fire([{ type, uri: toView(u) }]);
    ctx.subscriptions.push(w, w.onDidChange(fire(vscode.FileChangeType.Changed)), w.onDidDelete(fire(vscode.FileChangeType.Deleted)));
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const s = await fs.stat(toFile(uri).fsPath).catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
    return { type: vscode.FileType.File, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const xml = await fs.readFile(toFile(uri).fsPath, 'utf8').catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
    if (isEncrypted(xml)) throw vscode.FileSystemError.NoPermissions('This object is encrypted (TwinCAT object protection). Open it in TwinCAT XAE with a user that has access.');
    try {
      return Buffer.from(decode(stripBom(xml)), 'utf8');
    } catch (e) {
      if (e instanceof ConflictError) throw new vscode.FileSystemError(e.message);
      throw new vscode.FileSystemError(`Cannot show as ST: ${(e as Error).message}`);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const path = toFile(uri).fsPath;
    const raw = await fs.readFile(path, 'utf8');
    const bom = raw.startsWith('\ufeff') ? '\ufeff' : '';
    let out: string;
    try {
      out = encode(stripBom(raw), Buffer.from(content).toString('utf8'));
    } catch (e) {
      // surfaces as "Failed to save ...: <message>" and keeps the editor dirty
      throw new vscode.FileSystemError(e instanceof ViewError ? e.message : `Save failed: ${(e as Error).message}`);
    }
    if (bom + out !== raw) await fs.writeFile(path, bom + out, 'utf8');
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Not supported'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Delete the object in TwinCAT or the file explorer'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Rename the object in TwinCAT'); }
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** True when the file's XML structure (not just ST code inside CDATA) has unresolved conflict markers. */
async function xmlConflict(file: vscode.Uri): Promise<boolean> {
  try {
    decode(stripBom(await fs.readFile(file.fsPath, 'utf8')));
    return false;
  } catch (e) {
    return e instanceof ConflictError;
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, new TcStFileSystem(ctx), { isCaseSensitive: true }),
  );

  // Workspace model, project tree and object commands.
  const state = new WorkspaceState();
  const libraries = registerLibrarySources(ctx, state);
  const tree = new ProjectTree(state, libraries);
  ctx.subscriptions.push(
    state,
    vscode.window.createTreeView('iecode.projects', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.commands.registerCommand('iecode.refresh', () => state.reload()),
    vscode.commands.registerCommand('iecode.showGraph', () => showGraph(state)),
    vscode.commands.registerCommand('iecode.libraries', (n?: Node) =>
      showLibraryManager(ctx, state, n?.kind === 'reference' ? n.ref.effective.name : undefined)),
  );
  objects.register(ctx, state);
  engineering.register(ctx, state);
  language.register(ctx, state, libraries);
  commentColor.register(ctx);
  mergeConflicts.register(ctx);
  compare.register(ctx);
  setup.register(ctx);
  registerIoYaml(ctx);
  registerIoLinkView(ctx, state);
  registerVisuEditor(ctx);
  registerAiChat(ctx);
  registerPlcArchiveEditor(ctx);
  // tree node; a .tsproj / .xti Uri (explorer) or resource state (Source Control)
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.ioLinks', async (n?: Node | vscode.Uri | vscode.SourceControlResourceState) => {
    const uri = n instanceof vscode.Uri ? n : n && 'resourceUri' in n ? n.resourceUri : undefined;
    if (uri) return showIoLinks(ctx, state, uri.scheme === 'file' ? await owningProject(uri.fsPath) : undefined);
    const node = n as Node | undefined;
    if (node?.kind === 'system') return showIoLinks(ctx, state, node.project.file);
    const sln = node && 'unit' in node ? node.unit.solution : undefined;
    const tsproj = sln?.projects.find(p => !p.plcOnly && p.plcs.some(x => node && 'unit' in node && x.file === node.unit.plc.file))?.file;
    showIoLinks(ctx, state, tsproj);
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.adsInterface', (n?: Node) =>
    showAdsInterface(ctx, state, n && 'unit' in n ? n.unit.plc.file : undefined)));
  // tree node, a .plcproj (explorer / editor) or a pick of the workspace's PLC projects
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.projectSettings', async (n?: Node | vscode.Uri) => {
    let file = n instanceof vscode.Uri ? n.fsPath : n && 'unit' in n ? n.unit.plc.file : undefined;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!file && active && /\.plcproj$/i.test(active.fsPath)) file = active.fsPath;
    if (!file) {
      const units = state.current.units;
      if (!units.length) return vscode.window.showInformationMessage('IECode: no PLC project (.plcproj) in this workspace.');
      const pick = units.length === 1 ? { file: units[0].plc.file } : await vscode.window.showQuickPick(
        units.map(u => ({ label: u.id, description: u.group, file: u.plc.file })), { placeHolder: 'PLC project' });
      file = pick?.file;
    }
    if (file) showProjectSettings(file);
  }));
  void state.reload();

  // Give every iecode: document the ST language (also restored tabs after reload).
  const setLang = (d: vscode.TextDocument) => {
    if (![SCHEME, LIB_SCHEME, compare.REV_SCHEME, compare.SRC_SCHEME].includes(d.uri.scheme)) return;
    // visualizations, text lists, image pools and the visualization manager compare as YAML
    const lang = SUMMARY_RE.test(d.uri.path) ? 'yaml' : LANG;
    if (d.languageId !== lang) vscode.languages.setTextDocumentLanguage(d, lang);
  };
  vscode.workspace.textDocuments.forEach(setLang);
  ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(setLang));

  const openView = async (file?: vscode.Uri) => {
    file ??= vscode.window.activeTextEditor?.document.uri;
    if (!file) return;
    // visualizations, text lists, tasks …: no ST view, open the file itself (e.g. from the project tree)
    if (!EXT_RE.test(file.path)) { if (file.scheme === 'file') await vscode.commands.executeCommand('vscode.open', file); return; }
    if (file.scheme === SCHEME) file = toFile(file);
    // conflicted XML: open the file itself (the redirect below keeps it and explains why)
    if (file.scheme === 'file' && await xmlConflict(file)) { await vscode.window.showTextDocument(file, { preview: false }); return; }
    const doc = await vscode.workspace.openTextDocument(toView(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    void offerLineIdsCleanup(file);
  };

  // Conflict markers left only in <LineIds>: the view looks clean, but TwinCAT cannot load the file.
  const offerLineIdsCleanup = async (file: vscode.Uri) => {
    const raw = await fs.readFile(file.fsPath, 'utf8').catch(() => '');
    if (!CONFLICT_RE.test(raw) || await xmlConflict(file) || CONFLICT_RE.test(decode(stripBom(raw)))) return;
    const name = file.path.split('/').pop();
    const fix = 'Remove line mapping';
    if (await vscode.window.showWarningMessage(`${name}: the merge conflict is only in the line mapping (<LineIds>), which TwinCAT regenerates.`, fix) !== fix) return;
    const now = await fs.readFile(file.fsPath, 'utf8');
    const bom = now.startsWith('﻿') ? '﻿' : '';
    await fs.writeFile(file.fsPath, bom + encode(stripBom(now), decode(stripBom(now))), 'utf8');
  };

  // A conflict in the XML structure (e.g. after a merge while the ST view is open): switch that tab to the XML.
  const toXmlOnConflict = async (file: vscode.Uri) => {
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme === SCHEME && t.input.uri.fsPath === file.fsPath);
    if (!tabs.length || !await xmlConflict(file)) return;
    for (const t of tabs) {
      await vscode.window.showTextDocument(file, { viewColumn: t.group.viewColumn, preview: false });
      await vscode.window.tabGroups.close(t);
    }
    void vscode.window.showWarningMessage(`${file.path.split('/').pop()}: unresolved merge conflict in the XML structure. Resolve it here, then reopen as ST.`);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
  ctx.subscriptions.push(watcher, watcher.onDidChange(toXmlOnConflict), watcher.onDidCreate(toXmlOnConflict));

  // Files the user explicitly asked to see as XML are not redirected.
  const xmlExempt = new Set<string>();

  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.openAsST', (u?: vscode.Uri) => openView(u)),
    vscode.commands.registerCommand('iecode.openAsXml', async (u?: vscode.Uri) => {
      u ??= vscode.window.activeTextEditor?.document.uri;
      if (!u) return;
      const file = u.scheme === SCHEME ? toFile(u) : u;
      xmlExempt.add(file.toString());
      await vscode.window.showTextDocument(file, { preview: false });
    }),
  );

  // Auto-redirect: opening a .TcPOU from the explorer shows the ST view instead of the XML.
  ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(async e => {
    if (!vscode.workspace.getConfiguration('iecode').get<boolean>('openAsST', true)) return;
    for (const tab of e.opened) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText)) continue;
      const u = input.uri;
      if (u.scheme !== 'file' || !EXT_RE.test(u.path) || xmlExempt.has(u.toString())) continue;
      // a merge conflict in the XML structure can only be resolved in the XML: keep that tab
      if (await xmlConflict(u)) {
        void vscode.window.showWarningMessage(`${u.path.split('/').pop()}: unresolved merge conflict in the XML structure. Resolve it here, then reopen as ST.`);
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(toView(u));
      await vscode.window.showTextDocument(doc, { viewColumn: tab.group.viewColumn, preview: tab.isPreview });
      // a preview tab may already have been replaced by the ST view
      const still = tab.group.tabs.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === u.toString());
      if (still) await vscode.window.tabGroups.close(still);
      void offerLineIdsCleanup(u);
    }
  }));

  // Outline / breadcrumbs: one symbol per section.
  const selector: vscode.DocumentSelector = { language: LANG };
  ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(doc) {
      const heads = outline(doc.getText());
      const kinds: Record<string, vscode.SymbolKind> = {
        METHOD: vscode.SymbolKind.Method, PROPERTY: vscode.SymbolKind.Property, GET: vscode.SymbolKind.Function,
        SET: vscode.SymbolKind.Function, ACTION: vscode.SymbolKind.Event, TRANSITION: vscode.SymbolKind.Event,
      };
      const end = (i: number) => (i + 1 < heads.length ? heads[i + 1].line - 1 : doc.lineCount - 1);
      const mainName = doc.uri.path.split('/').pop()!.replace(EXT_RE, '');
      const mainEnd = heads.length ? heads[0].line - 1 : doc.lineCount - 1;
      const syms = [new vscode.DocumentSymbol(mainName, '', vscode.SymbolKind.Class,
        new vscode.Range(0, 0, mainEnd, 0), new vscode.Range(0, 0, 0, 0))];
      heads.forEach((h, i) => {
        const r = new vscode.Range(h.line, 0, end(i), doc.lineAt(end(i)).text.length);
        syms.push(new vscode.DocumentSymbol(h.kind === 'GET' || h.kind === 'SET' ? `${h.name}.${h.kind.toLowerCase()}` : h.name,
          h.kind.toLowerCase(), kinds[h.kind], r, doc.lineAt(h.line).range));
      });
      return syms;
    },
  }));

  // Fold each section (and each implementation block) on its header line.
  ctx.subscriptions.push(vscode.languages.registerFoldingRangeProvider(selector, {
    provideFoldingRanges(doc) {
      const ranges: vscode.FoldingRange[] = [];
      const heads: number[] = [];
      for (let i = 0; i < doc.lineCount; i++) if (HEADER_RE.test(doc.lineAt(i).text)) heads.push(i);
      heads.forEach((h, i) => ranges.push(new vscode.FoldingRange(h, (heads[i + 1] ?? doc.lineCount) - 1, vscode.FoldingRangeKind.Region)));
      for (let i = 0; i < doc.lineCount; i++) {
        if (!IMPL_RE.test(doc.lineAt(i).text)) continue;
        const next = heads.find(h => h > i) ?? doc.lineCount;
        if (next - 1 > i) ranges.push(new vscode.FoldingRange(i, next - 1));
      }
      return ranges;
    },
  }));
}

export function deactivate() {}
