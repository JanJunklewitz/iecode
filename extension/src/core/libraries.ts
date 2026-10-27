// Data behind the library manager: installed references, available versions, updates and
// inconsistencies across the workspace. Pure functions; the webview only renders the result.

import { promises as fs } from 'fs';
import * as path from 'path';
import { LibraryId, formatLibraryId } from './projects';
import { WorkspaceModel, librariesByTitle } from './workspace';
import { compareVersions } from './references';

export type Source = 'workspace' | 'repository' | 'folder';

export interface Available { name: string; version: string; vendor: string; source: Source; location: string }

export interface ProjectRef { unit: string; plcFile: string; placeholder: string; version: string; pinned: boolean; kind: 'placeholder' | 'library' }

export interface LibraryRow {
  name: string;
  vendor: string;
  usedBy: ProjectRef[];
  versions: string[];          // available versions, newest first (without '*')
  latest?: string;
  workspace?: { unit: string; version: string };
  /** Pinned references older than the newest available version. */
  outdated: ProjectRef[];
  /** More than one effective version in use across the workspace. */
  inconsistent: boolean;
}

/** Scans a TwinCAT library repository (<vendor>/<library>/<version>/). Names on disk are lower-case. */
export async function scanRepository(root: string): Promise<Available[]> {
  const out: Available[] = [];
  const dirs = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(d => d.name);
  for (const vendor of await dirs(root))
    for (const lib of await dirs(path.join(root, vendor)))
      for (const ver of await dirs(path.join(root, vendor, lib)))
        if (/^\d/.test(ver)) out.push({ name: lib, version: ver, vendor, source: 'repository', location: path.join(root, vendor, lib, ver) });
  return out;
}

/** Scans a folder for library files named <Name>_<Version>.library / .compiled-library (vendor unknown). */
export async function scanFolder(root: string): Promise<Available[]> {
  const out: Available[] = [];
  for (const f of await fs.readdir(root).catch(() => [] as string[])) {
    const m = /^(.+?)_(\d+(?:\.\d+){1,3})\.(?:compiled-)?library$/i.exec(f);
    if (m) out.push({ name: m[1], version: m[2], vendor: '', source: 'folder', location: path.join(root, f) });
  }
  return out;
}

const key = (name: string) => name.toLowerCase();

export function overview(model: Pick<WorkspaceModel, 'units'>, available: Available[]): LibraryRow[] {
  const rows = new Map<string, LibraryRow>();
  const row = (id: Pick<LibraryId, 'name' | 'vendor'>) => {
    let r = rows.get(key(id.name));
    if (!r) rows.set(key(id.name), (r = { name: id.name, vendor: id.vendor, usedBy: [], versions: [], outdated: [], inconsistent: false }));
    if (!r.vendor && id.vendor) r.vendor = id.vendor;
    return r;
  };

  const libs = librariesByTitle(model.units as WorkspaceModel['units']);
  for (const [, u] of libs) {
    const r = row({ name: u.plc.title!, vendor: u.plc.company ?? '' });
    r.workspace = { unit: u.id, version: u.plc.version! };
    r.name = u.plc.title!;
  }
  for (const a of available) {
    const r = row(a);
    if (!r.versions.includes(a.version)) r.versions.push(a.version);
  }
  for (const u of model.units)
    for (const ref of u.plc.references) {
      const r = row(ref.effective);
      r.name = ref.effective.name;          // references carry the proper casing
      r.vendor = ref.effective.vendor;
      r.usedBy.push({ unit: u.id, plcFile: u.plc.file, placeholder: ref.placeholder, version: ref.effective.version, pinned: ref.effective.version !== '*', kind: ref.kind });
    }

  for (const r of rows.values()) {
    if (r.workspace && !r.versions.includes(r.workspace.version)) r.versions.push(r.workspace.version);
    r.versions.sort((a, b) => compareVersions(b, a));
    r.latest = r.versions[0];
    r.outdated = r.latest ? r.usedBy.filter(u => u.pinned && compareVersions(u.version, r.latest!) < 0) : [];
    r.inconsistent = new Set(r.usedBy.map(u => u.version)).size > 1;
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ add / remove references (text edits)

const eolOf = (s: string) => (s.includes('\r\n') ? '\r\n' : '\n');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hasReference(text: string, name: string): boolean {
  return new RegExp(`<PlaceholderReference\\s+Include="${esc(name)}"|<LibraryReference\\s+Include="${esc(name)}\\s*,`, 'i').test(text);
}

/** Adds a placeholder reference like XAE's library manager does. */
export function addReference(text: string, id: LibraryId): string {
  if (hasReference(text, id.name)) throw new Error(`${id.name} is already referenced`);
  const eol = eolOf(text);
  const entry = (ind: string) =>
    `${ind}<PlaceholderReference Include="${id.name}">${eol}${ind}  <DefaultResolution>${formatLibraryId(id)}</DefaultResolution>${eol}${ind}  <Namespace>${id.name}</Namespace>${eol}${ind}</PlaceholderReference>`;
  const re = /(^[ \t]*)<PlaceholderReference\s+Include="[^"]*">[\s\S]*?<\/PlaceholderReference>/gm;
  let last: RegExpExecArray | null = null;
  for (let m; (m = re.exec(text));) last = m;
  if (last) {
    const at = last.index + last[0].length;
    return text.slice(0, at) + eol + entry(last[1]) + text.slice(at);
  }
  const close = text.lastIndexOf('</Project>');
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  return text.slice(0, lineStart) + `  <ItemGroup>${eol}${entry('    ')}${eol}  </ItemGroup>${eol}` + text.slice(lineStart);
}

/** Removes a library reference (placeholder or direct) and its pinned resolution. */
export function removeReference(text: string, name: string): string {
  const n = esc(name);
  return text
    .replace(new RegExp(`^[ \\t]*<PlaceholderReference\\s+Include="${n}">[\\s\\S]*?</PlaceholderReference>\\r?\\n?`, 'im'), '')
    .replace(new RegExp(`^[ \\t]*<PlaceholderResolution\\s+Include="${n}">[\\s\\S]*?</PlaceholderResolution>\\r?\\n?`, 'im'), '')
    .replace(new RegExp(`^[ \\t]*<LibraryReference\\s+Include="${n}\\s*,[^"]*"\\s*(?:/>|>[\\s\\S]*?</LibraryReference>)\\r?\\n?`, 'im'), '');
}

// ------------------------------------------------------------------ library sources (navigation into .library files)

export interface LibrarySourceFile { file?: string; version?: string; compiled?: boolean }

/** The .library file of a referenced library among the available ones ('*' = newest). A .compiled-library has
 *  no sources: then only `compiled` is set. */
export async function findLibrarySource(id: LibraryId, available: Available[]): Promise<LibrarySourceFile> {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const cands = available
    .filter(a => same(a.name, id.name) && (!a.vendor || !id.vendor || same(a.vendor, id.vendor)) && (id.version === '*' || a.version === id.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  let compiled = false;
  // only the version TwinCAT would use: sources of another version would be misleading
  for (const a of cands.filter(c => c.version === cands[0].version)) {
    let files: string[];
    if (a.source === 'repository') {
      const names = await fs.readdir(a.location).catch(() => [] as string[]);
      files = names.filter(n => /\.library$/i.test(n)).sort((x, y) => Number(same(y, `${id.name}.library`)) - Number(same(x, `${id.name}.library`)))
        .map(n => path.join(a.location, n));
      compiled ||= names.some(n => /\.compiled-library$/i.test(n));
    } else {
      files = /\.compiled-library$/i.test(a.location) ? [] : [a.location];
      compiled ||= files.length === 0;
    }
    if (files.length) return { file: files[0], version: a.version };
  }
  return compiled ? { compiled } : {};
}
