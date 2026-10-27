// VS Code language features for the plain-ST view (iecode: documents), backed by the SymbolIndex.

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { SymbolIndex, Location } from './index';
import { PlcSymbol, Range } from './parser';
import { decode } from '../model';
import { isEncrypted } from '../core/projects';
import { WorkspaceState } from '../state';
import { LIB_SCHEME, LibrarySources } from './librarySources';

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

export function register(ctx: vscode.ExtensionContext, state: WorkspaceState, libraries: LibrarySources) {
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
  const fromDoc = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== SCHEME || doc.languageId !== LANG) return;
    const obj = index.update(doc.uri.fsPath, doc.getText());
    problems.set(doc.uri, obj.parsed.problems.map(p => {
      const d = new vscode.Diagnostic(vrange(p.range), p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'IECode';
      return d;
    }));
  };
  state.onDidChange(() => void reindex());
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(fromDoc),
    vscode.workspace.onDidChangeTextDocument(e => fromDoc(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => d.uri.scheme === SCHEME && problems.delete(d.uri)),
  );
  void reindex().then(() => vscode.workspace.textDocuments.forEach(fromDoc));

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
  );
}

function hoverText(s: PlcSymbol, owner?: PlcSymbol): string {
  if (s.kind === 'VARIABLE' || s.kind === 'FIELD') return `${s.scope ? s.scope + ' ' : ''}${s.name} : ${s.type ?? '?'}`;
  if (s.kind === 'ENUM_VALUE') return `${owner?.name ?? ''}.${s.name}`;
  return s.detail;
}
