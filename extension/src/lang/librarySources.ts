// Sources of the referenced (non-compiled) .library files: resolved from the library repository and the
// configured library folders, read without TwinCAT and shown read-only as iecode-lib: documents.
//
//   iecode-lib:/C:/…/Tc3_Foo/1.2.0/Tc3_Foo.library/POUs/FB_Foo.TcPOU   ST view of FB_Foo inside that library

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { LibraryId } from '../core/projects';
import { librariesByTitle } from '../core/workspace';
import { findLibrarySource } from '../core/libraries';
import { LibraryObject, readLibraryArchive } from '../core/libraryArchive';
import { availableLibraries } from '../views/libraryManager';
import { decode } from '../model';

export const LIB_SCHEME = 'iecode-lib';

export interface LibrarySource {
  id: LibraryId;
  /** The .library file; unset when no sources were found. */
  file?: string;
  version?: string;
  compiled?: boolean;
  error?: string;
  /** Referenced by a workspace project (not only through another library). */
  direct: boolean;
  objects: { key: string; obj: LibraryObject }[];
}

/** At most this many libraries are read (direct references and what they reference, breadth first). */
const MAX_LIBRARIES = 60;

export class LibrarySources implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after the set of library sources was rebuilt. */
  readonly onDidChange = this.changed.event;
  private readonly fileEvents = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.fileEvents.event;

  private libs = new Map<string, LibrarySource>();                 // lower-case library name
  private views = new Map<string, { obj: LibraryObject; library: string; view?: string }>();   // lower-case key
  private cache = new Map<string, { mtime: number; objects: LibraryObject[]; deps: LibraryId[] }>();
  private loading: Promise<void> | undefined;
  private again = false;

  constructor(private readonly state: WorkspaceState) {}

  static uri(key: string) { return vscode.Uri.file(key).with({ scheme: LIB_SCHEME }); }
  isLibraryKey(key: string) { return this.views.has(key.toLowerCase()); }

  /** Library of a referenced name (lower-case match), once loaded. */
  get(name: string) { return this.libs.get(name.toLowerCase()); }
  all() { return [...this.libs.values()]; }

  /** Namespaces of the libraries referenced in the workspace (placeholder / namespace name → library name). */
  namespaces(): Map<string, string> {
    const m = new Map<string, string>();
    for (const u of this.state.current.units)
      for (const r of u.plc.references) { m.set(r.placeholder, r.effective.name); m.set(r.effective.name, r.effective.name); }
    for (const l of this.libs.values()) m.set(l.id.name, l.id.name);
    return m;
  }

  /** Re-resolves and reads the library sources (coalesces concurrent calls). */
  refresh(): Promise<void> {
    if (this.loading) { this.again = true; return this.loading; }
    this.loading = (async () => {
      try {
        do { this.again = false; await this.load(); } while (this.again);
      } finally { this.loading = undefined; }
    })();
    return this.loading;
  }

  private async load() {
    const model = this.state.current;
    const inWorkspace = librariesByTitle(model.units);
    const available = await availableLibraries();
    const libs = new Map<string, LibrarySource>();
    const queue: { id: LibraryId; direct: boolean }[] = model.units.flatMap(u => u.plc.references.map(r => ({ id: r.effective, direct: true })));
    while (queue.length && libs.size < MAX_LIBRARIES) {
      const { id, direct } = queue.shift()!;
      const k = id.name.toLowerCase();
      if (inWorkspace.has(k)) continue;                        // a library project in the workspace: indexed as such
      const have = libs.get(k);
      if (have) { have.direct ||= direct; continue; }
      const src: LibrarySource = { id, direct, objects: [] };
      libs.set(k, src);
      try {
        Object.assign(src, await findLibrarySource(id, available));
        if (!src.file) continue;
        const { objects, deps } = await this.read(src.file);
        // canonical file system path (as Uri.fsPath gives it back), so document URIs map to the same key
        src.objects = objects.map(obj => ({ key: vscode.Uri.file(path.join(src.file!, ...obj.folder.split('/').filter(Boolean), obj.name + obj.ext)).fsPath, obj }));
        queue.push(...deps.map(d => ({ id: d, direct: false })));
      } catch (e) {
        src.error = (e as Error).message;
        console.warn(`IECode: ${src.file ?? id.name}: ${src.error}`);
      }
    }
    this.libs = libs;
    const views = new Map<string, { obj: LibraryObject; library: string; view?: string }>();
    for (const l of libs.values()) for (const o of l.objects) views.set(o.key.toLowerCase(), { obj: o.obj, library: l.id.name });
    this.views = views;
    this.changed.fire();
    const open = vscode.workspace.textDocuments.filter(d => d.uri.scheme === LIB_SCHEME);
    if (open.length) this.fileEvents.fire(open.map(d => ({ type: vscode.FileChangeType.Changed, uri: d.uri })));
  }

  private async read(file: string) {
    const st = await fs.stat(file);
    const hit = this.cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const a = readLibraryArchive(await fs.readFile(file));
    const entry = { mtime: st.mtimeMs, objects: a.objects, deps: a.dependencies };
    this.cache.set(file, entry);
    return entry;
  }

  /** ST view text of a library object by key (file system path), with the name of its library. */
  view(key: string): { text: string; library: string } | undefined {
    const v = this.views.get(key.toLowerCase());
    if (!v) return undefined;
    v.view ??= decode(v.obj.xml);
    return { text: v.view, library: v.library };
  }

  /** All library objects: key, library name. */
  keys(): { key: string; library: string }[] {
    return this.all().flatMap(l => l.objects.map(o => ({ key: o.key, library: l.id.name })));
  }

  // ---------------------------------------------------------------- read-only file system

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }

  stat(uri: vscode.Uri): vscode.FileStat {
    const v = this.view(uri.fsPath);
    if (!v) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(v.text), permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (!this.views.size) await (this.loading ?? this.refresh());           // restored tab before the first load
    const v = this.view(uri.fsPath);
    if (!v) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(v.text, 'utf8');
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  writeFile(): void { throw vscode.FileSystemError.NoPermissions('Library sources are read-only: change them in the library project.'); }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Library sources are read-only.'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Library sources are read-only.'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Library sources are read-only.'); }

  dispose() { this.changed.dispose(); this.fileEvents.dispose(); }
}

export function registerLibrarySources(ctx: vscode.ExtensionContext, state: WorkspaceState): LibrarySources {
  const sources = new LibrarySources(state);
  ctx.subscriptions.push(
    sources,
    vscode.workspace.registerFileSystemProvider(LIB_SCHEME, sources, { isCaseSensitive: false, isReadonly: true }),
    state.onDidChange(() => void sources.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.libraryRepository') || e.affectsConfiguration('iecode.librarySources')) void sources.refresh(); }),
  );
  return sources;
}
