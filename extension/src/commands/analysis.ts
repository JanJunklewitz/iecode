// Wires the object graph analysis to the workspace: files come from disk (never the editor buffers), results are
// computed lazily on the first request and dropped when a source file, a project or a library source changes.

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { AnalysisState } from '../core/analysisState';
import { DEFAULT_ROOT_PRAGMAS } from '../core/analysisRoots';
import { WorkspaceState } from '../state';
import { LibrarySources } from '../lang/librarySources';

export function registerAnalysis(ctx: vscode.ExtensionContext, state: WorkspaceState, libraries: LibrarySources): AnalysisState {
  const analysis = new AnalysisState({
    model: () => state.current,
    read: async file => {
      try {
        const st = await fs.stat(file);
        return { text: await fs.readFile(file, 'utf8'), stamp: `${st.mtimeMs}:${st.size}` };
      } catch { return undefined; }
    },
    libraryObjects: unit => libraries.librariesOf(unit).flatMap(l => l.objects.flatMap(o => {
      const v = libraries.view(o.key);
      return v ? [{ key: o.key, view: v.text, library: v.library }] : [];
    })),
    namespaces: unit => {
      const m = new Map<string, string>();
      for (const r of unit.plc.references) { m.set(r.placeholder, r.effective.name); m.set(r.effective.name, r.effective.name); }
      for (const l of libraries.librariesOf(unit)) m.set(l.id.name, l.id.name);
      return m;
    },
    settings: () => {
      const c = vscode.workspace.getConfiguration('iecode.analysis');
      return { rootObjects: c.get<string[]>('rootObjects', []), rootPragmas: c.get<string[]>('rootPragmas', DEFAULT_ROOT_PRAGMAS) };
    },
  });
  // saves and file system events only; a keystroke in the ST view does not change the files on disk
  const drop = () => analysis.invalidate();
  const w = vscode.workspace.createFileSystemWatcher('**/*.{plcproj,TcPOU,TcDUT,TcGVL,TcIO,TcTTO,TcVIS}');
  ctx.subscriptions.push(
    analysis, w, w.onDidChange(drop), w.onDidCreate(drop), w.onDidDelete(drop),
    state.onDidChange(drop), libraries.onDidChange(drop),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.analysis')) drop(); }),
  );
  return analysis;
}
