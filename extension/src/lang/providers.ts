// VS Code language features for the plain-ST view (iecode: documents), backed by the SymbolIndex.

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { SymbolIndex, Location } from './index';
import { PlcSymbol, Range } from './parser';
import { decode } from '../model';
import { isEncrypted } from '../core/projects';
import { WorkspaceState } from '../state';
import { LIB_SCHEME, LibrarySources } from './librarySources';
import { elementAt } from './arrays';
import { describeMissing, memberStubs, missingMembers } from './inheritance';

/** Diagnostic code of "function block does not implement …", for the quick fix. */
export const MISSING_MEMBERS = 'iecode.missingMembers';

/** What other features (commands, views) use from the language support. */
export interface LanguageApi {
  index: SymbolIndex;
  /** Resolves once the workspace (and open documents) are indexed. */
  ready(): Promise<void>;
  /** Stub sections for everything the object (given as view text, indexed under `file`) must still implement. */
  stubsFor(file: string, view: string): string;
  /** View URI (iecode: or iecode-lib:) of an indexed file. */
  toView(file: string): vscode.Uri;
}

const LANG = 'twincat-st';
const SCHEME = 'iecode';
const vrange = (r: Range) => new vscode.Range(r.line, r.col, r.endLine, r.endCol);

const SYMBOL_KIND: Record<string, vscode.SymbolKind> = {
  FUNCTION_BLOCK: vscode.SymbolKind.Class, PROGRAM: vscode.SymbolKind.Module, FUNCTION: vscode.SymbolKind.Function,
  INTERFACE: vscode.SymbolKind.Interface, STRUCT: vscode.SymbolKind.Struct, UNION: vscode.SymbolKind.Struct,
  ENUM: vscode.SymbolKind.Enum, ALIAS: vscode.SymbolKind.TypeParameter, GVL: vscode.SymbolKind.Namespace,
  METHOD: vscode.SymbolKind.Method, PROPERTY: vscode.SymbolKind.Property, ACTION: vscode.SymbolKind.Event,
  TRANSITION: vscode.SymbolKind.Event, VARIABLE: vscode.SymbolKind.Variable, FIELD: vscode.SymbolKind.Field,
  ENUM_VALUE: vscode.SymbolKind.EnumMember,
};
const COMPLETION_KIND: Record<string, vscode.CompletionItemKind> = {
  FUNCTION_BLOCK: vscode.CompletionItemKind.Class, PROGRAM: vscode.CompletionItemKind.Module, FUNCTION: vscode.CompletionItemKind.Function,
  INTERFACE: vscode.CompletionItemKind.Interface, STRUCT: vscode.CompletionItemKind.Struct, UNION: vscode.CompletionItemKind.Struct,
  ENUM: vscode.CompletionItemKind.Enum, ALIAS: vscode.CompletionItemKind.TypeParameter, GVL: vscode.CompletionItemKind.Module,
  METHOD: vscode.CompletionItemKind.Method, PROPERTY: vscode.CompletionItemKind.Property, ACTION: vscode.CompletionItemKind.Event,
  TRANSITION: vscode.CompletionItemKind.Event, VARIABLE: vscode.CompletionItemKind.Variable, FIELD: vscode.CompletionItemKind.Field,
  ENUM_VALUE: vscode.CompletionItemKind.EnumMember, KEYWORD: vscode.CompletionItemKind.Keyword, TYPE: vscode.CompletionItemKind.TypeParameter,
};

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState, libraries: LibrarySources): LanguageApi {
  const index = new SymbolIndex();
  const toView = (file: string) => libraries.isLibraryKey(file) ? LibrarySources.uri(file) : vscode.Uri.file(file).with({ scheme: SCHEME });
  const libraryOf = (file: string) => index.get(file)?.library;
  const mtimes = new Map<string, number>();
  const problems = vscode.languages.createDiagnosticCollection('iecode-st');
  ctx.subscriptions.push(problems);

  /** Index every object file of the workspace (only files that changed since the last pass). */
  const reindex = async () => {
    const files = new Set(state.current.units.flatMap(u => u.plc.objects.map(o => o.file)).filter(f => /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i.test(f)));
    for (const f of [...mtimes.keys()]) if (!files.has(f)) { index.remove(f); mtimes.delete(f); }
    for (const f of files) {
      if (vscode.workspace.textDocuments.some(d => d.uri.scheme === SCHEME && d.uri.fsPath === f && d.isDirty)) continue;
      try {
        const st = await fs.stat(f);
        if (mtimes.get(f) === st.mtimeMs) continue;
        const xml = await fs.readFile(f, 'utf8');
        mtimes.set(f, st.mtimeMs);
        if (isEncrypted(xml)) { index.remove(f); continue; }
        index.update(f, decode(xml.replace(/^﻿/, '')));
      } catch { /* unreadable or not an ST object: skip */ }
    }
  };

  /** Index the sources of referenced libraries (read-only, replaced as a whole when they change). */
  const libKeys = new Set<string>();
  const reindexLibraries = () => {
    const now = new Set<string>();
    for (const { key, library } of libraries.keys()) {
      now.add(key);
      if (libKeys.has(key)) continue;
      try {
        const v = libraries.view(key);
        if (v) index.update(key, v.text, library);
      } catch { /* not decodable: skip */ }
    }
    for (const k of libKeys) if (!now.has(k)) index.remove(k);
    libKeys.clear();
    now.forEach(k => libKeys.add(k));
    index.setNamespaces(libraries.namespaces());
  };
  // a library may have been rebuilt with the same path: drop everything and index again
  libraries.onDidChange(() => { for (const k of libKeys) index.remove(k); libKeys.clear(); reindexLibraries(); });

  /** Keep the open (possibly unsaved) document as the source of truth for its file. */
  const isView = (doc: vscode.TextDocument) => doc.uri.scheme === SCHEME && doc.languageId === LANG;
  const diagnose = (doc: vscode.TextDocument) => {
    const obj = index.get(doc.uri.fsPath);
    if (!obj) return;
    const out = obj.parsed.problems.map(p => {
      const d = new vscode.Diagnostic(vrange(p.range), p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'IECode';
      return d;
    });
    // an abstract function block may leave members to its derived classes
    if (obj.root?.kind === 'FUNCTION_BLOCK' && !obj.root.modifiers?.includes('ABSTRACT')) {
      const { missing } = missingMembers(index, obj);
      if (missing.length) {
        const d = new vscode.Diagnostic(vrange(obj.root.range), describeMissing(obj, missing), vscode.DiagnosticSeverity.Error);
        d.source = 'IECode';
        d.code = MISSING_MEMBERS;
        out.push(d);
      }
    }
    problems.set(doc.uri, out);
  };
  // members of base classes and interfaces change in other files: check every open view again
  let pending: NodeJS.Timeout | undefined;
  const diagnoseAll = () => {
    clearTimeout(pending);
    pending = setTimeout(() => vscode.workspace.textDocuments.filter(isView).forEach(diagnose), 150);
  };
  ctx.subscriptions.push({ dispose: () => clearTimeout(pending) });
  const fromDoc = (doc: vscode.TextDocument) => {
    if (!isView(doc)) return;
    const obj = index.get(doc.uri.fsPath);
    if (obj?.view === doc.getText()) return;
    index.update(doc.uri.fsPath, doc.getText());
    diagnose(doc);
    diagnoseAll();
  };
  state.onDidChange(() => void reindex().then(diagnoseAll));
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(d => { fromDoc(d); if (isView(d)) diagnose(d); }),
    vscode.workspace.onDidChangeTextDocument(e => fromDoc(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => d.uri.scheme === SCHEME && problems.delete(d.uri)),
  );
  const initial = reindex().then(() => { vscode.workspace.textDocuments.forEach(fromDoc); diagnoseAll(); });

  const at = (doc: vscode.TextDocument, p: vscode.Position): Location | undefined => {
    fromDoc(doc);
    return index.resolve(doc.uri.fsPath, p.line, p.character);
  };
  const selector: vscode.DocumentSelector = [{ language: LANG, scheme: SCHEME }, { language: LANG, scheme: LIB_SCHEME }];

  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc, p) {
        const l = at(doc, p);
        return l && new vscode.Location(toView(l.file), vrange(l.range));
      },
    }),

    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(doc, p, c) {
        const l = at(doc, p);
        if (!l) return [];
        return index.references(l)
          .filter(r => c.includeDeclaration || !(r.file === l.file && r.range.line === l.range.line && r.range.col === l.range.col))
          .map(r => new vscode.Location(toView(r.file), vrange(r.range)));
      },
    }),

    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, p) {
        const l = at(doc, p);
        if (!l) return;
        const s = l.symbol;
        const md = new vscode.MarkdownString();
        md.appendCodeblock(hoverText(s, l.owner), LANG);
        const lib = libraryOf(l.file);
        md.appendMarkdown(`\n${s.kind.toLowerCase().replace('_', ' ')}${l.owner ? ` of **${l.owner.name}**` : ''}${lib ? ` · library ${lib}` : ''}`);
        return new vscode.Hover(md);
      },
    }),

    // element index inside ARRAY initializers: aDevices[17]
    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, p) {
        fromDoc(doc);
        const text = elementAt(index.get(doc.uri.fsPath)?.parsed.arrays ?? [], p.line, p.character);
        return text ? new vscode.Hover(new vscode.MarkdownString().appendCodeblock(text, LANG)) : undefined;
      },
    }),

    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(doc, p) {
        fromDoc(doc);
        return index.completions(doc.uri.fsPath, p.line, p.character).map(c => {
          const it = new vscode.CompletionItem(c.label, COMPLETION_KIND[c.kind]);
          it.detail = c.detail;
          if (c.kind === 'KEYWORD' || c.kind === 'TYPE') it.sortText = 'z' + c.label;
          return it;
        });
      },
    }, '.'),

    vscode.languages.registerRenameProvider(selector, {
      prepareRename(doc, p) {
        const l = at(doc, p);
        if (!l) throw new Error('Nothing to rename here.');
        const lib = libraryOf(l.file);
        if (lib) throw new Error(`${l.symbol.name} is declared in library ${lib} (read-only).`);
        if (!['VARIABLE', 'FIELD', 'METHOD', 'PROPERTY', 'ACTION', 'ENUM_VALUE'].includes(l.symbol.kind))
          throw new Error('Rename objects (POUs, DUTs, GVLs) from the IECode project tree.');
        const w = doc.getWordRangeAtPosition(p);
        return w ? { range: w, placeholder: doc.getText(w) } : undefined;
      },
      provideRenameEdits(doc, p, newName) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) throw new Error(`'${newName}' is not a valid identifier.`);
        const l = at(doc, p);
        if (!l) return;
        const edit = new vscode.WorkspaceEdit();
        for (const r of index.references(l)) if (!libraryOf(r.file)) edit.replace(toView(r.file), vrange(r.range), newName);
        return edit;
      },
    }),

    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        const q = query.toLowerCase();
        const out: vscode.SymbolInformation[] = [];
        for (const o of index.objects()) {
          if (!o.root) continue;
          const add = (s: PlcSymbol, container: string) => {
            if (!q || s.name.toLowerCase().includes(q))
              out.push(new vscode.SymbolInformation(s.name, SYMBOL_KIND[s.kind], container, new vscode.Location(toView(o.file), vrange(s.range))));
          };
          add(o.root, o.library ?? '');
          for (const c of o.root.children) if (c.kind !== 'VARIABLE' || o.root.kind === 'GVL') add(c, o.root.name);
          if (out.length > 500) break;
        }
        return out;
      },
    }),

    // quick fix on "does not implement": append stubs for the missing members to the view
    vscode.languages.registerCodeActionsProvider({ language: LANG, scheme: SCHEME }, {
      provideCodeActions(doc, _range, c) {
        const diag = c.diagnostics.find(d => d.code === MISSING_MEMBERS);
        if (!diag) return [];
        const action = implementAction(doc);
        if (!action) return [];
        action.diagnostics = [diag];
        action.isPreferred = true;
        return [action];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );

  /** "Implement missing members" as an edit of the open view. */
  const implementAction = (doc: vscode.TextDocument): vscode.CodeAction | undefined => {
    fromDoc(doc);
    const obj = index.get(doc.uri.fsPath);
    if (!obj) return undefined;
    const { missing } = missingMembers(index, obj);
    if (!missing.length) return undefined;
    const text = doc.getText();
    const action = new vscode.CodeAction(`Implement ${missing.length === 1 ? `${missing[0].kind.toLowerCase()} ${missing[0].name}` : `${missing.length} missing members`}`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(doc.uri, doc.positionAt(text.length), (text.endsWith('\n') || !text ? '' : '\n') + memberStubs(missing));
    return action;
  };

  // project tree / editor: implement what a function block is missing (also when its view is not open)
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.implementMissing', async (n?: { kind: string; obj?: { file: string } } | vscode.Uri) => {
    const file = n instanceof vscode.Uri ? n.fsPath : n?.obj?.file ?? (vscode.window.activeTextEditor?.document.uri.scheme === SCHEME ? vscode.window.activeTextEditor.document.uri.fsPath : undefined);
    if (!file) return;
    await initial;
    await reindex();
    const doc = await vscode.workspace.openTextDocument(toView(file));
    const action = implementAction(doc);
    if (!action?.edit) return vscode.window.showInformationMessage(`IECode: ${index.get(file)?.root?.name ?? 'This object'} implements all members of its base classes and interfaces.`);
    const wasDirty = doc.isDirty;
    const from = doc.lineCount - (doc.getText().endsWith('\n') ? 1 : 0);
    await vscode.workspace.applyEdit(action.edit);
    if (!wasDirty) await doc.save();
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const at = new vscode.Position(Math.min(from + 1, doc.lineCount - 1), 0);
    ed.selection = new vscode.Selection(at, at);
    ed.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
  }));

  return {
    index,
    ready: () => initial.then(reindex),
    toView,
    stubsFor(file, view) {
      const prev = index.get(file);
      const obj = index.update(file, view);
      try {
        return memberStubs(missingMembers(index, obj).missing);
      } finally {
        if (prev) index.update(prev.file, prev.view, prev.library);
        else index.remove(file);
      }
    },
  };
}

function hoverText(s: PlcSymbol, owner?: PlcSymbol): string {
  if (s.kind === 'VARIABLE' || s.kind === 'FIELD') return `${s.scope ? s.scope + ' ' : ''}${s.name} : ${s.type ?? '?'}`;
  if (s.kind === 'ENUM_VALUE') return `${owner?.name ?? ''}.${s.name}`;
  return s.detail;
}
