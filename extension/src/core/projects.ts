// Reads TwinCAT solutions and PLC projects from disk (no TwinCAT needed):
//   .sln -> .tsproj / .tspproj -> .plcproj -> object files (.TcPOU, .TcDUT, ...)

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseXml, XNode, child, cdataText } from '../xml';

export type ObjectType =
  | 'FUNCTION_BLOCK' | 'PROGRAM' | 'FUNCTION' | 'INTERFACE'
  | 'STRUCT' | 'ENUM' | 'UNION' | 'ALIAS' | 'GVL' | 'TASK' | 'OTHER';

export interface PlcObject {
  /** Path relative to the .plcproj folder, with '/' separators. */
  rel: string;
  file: string;
  name: string;
  type: ObjectType;
  /** Encrypted by TwinCAT (object protection); content can't be shown. */
  encrypted?: boolean;
  /** EXTENDS / IMPLEMENTS from the declaration, for display. */
  extends?: string;
  implements?: string[];
}

export interface LibraryId { name: string; version: string; vendor: string }

export interface LibraryRef {
  placeholder: string;
  kind: 'placeholder' | 'library';
  default: LibraryId;
  pinned?: LibraryId;
  /** What TwinCAT uses: the pinned resolution, else the default. */
  effective: LibraryId;
}

export interface PlcProject {
  file: string;
  dir: string;
  name: string;
  title?: string;
  company?: string;
  version?: string;
  isLibrary: boolean;
  folders: string[];
  objects: PlcObject[];
  references: LibraryRef[];
  /** TwinCAT version the parent project was saved with, e.g. 3.1.4024.66. */
  tcVersion?: string;
}

export interface TwinCatProject {
  file: string;
  name: string;
  plcOnly: boolean;
  tcVersion?: string;
  plcs: PlcProject[];
}

export interface Solution {
  file: string;
  name: string;
  projects: TwinCatProject[];
}

const toPosix = (p: string) => p.replace(/\\/g, '/');
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const read = async (f: string) => stripBom(await fs.readFile(f, 'utf8'));
const exists = (f: string) => fs.access(f).then(() => true, () => false);

const textOf = (n: XNode | undefined, src: string) => (n ? src.slice(n.innerStart, n.innerEnd).trim() : undefined);
function* walk(n: XNode): Generator<XNode> { for (const c of n.children) { yield c; yield* walk(c); } }

export async function loadSolution(file: string): Promise<Solution> {
  const text = await read(file);
  const dir = path.dirname(file);
  const projects: TwinCatProject[] = [];
  const re = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.(?:tsproj|tspproj))"/gim;
  for (const m of text.matchAll(re)) {
    const p = path.resolve(dir, toPosix(m[1]));
    if (await exists(p)) projects.push(await loadTwinCatProject(p));
  }
  return { file, name: path.basename(file, '.sln'), projects };
}

export async function loadTwinCatProject(file: string): Promise<TwinCatProject> {
  const text = await read(file);
  const root = parseXml(text);
  const dir = path.dirname(file);
  const tcVersion = [...walk(root)].find(n => n.attrs.TcVersion)?.attrs.TcVersion;
  const plcs: PlcProject[] = [];
  for (const n of walk(root)) {
    if (n.name !== 'Project' || !n.attrs.PrjFilePath) continue;
    const p = path.resolve(dir, toPosix(n.attrs.PrjFilePath));
    if (await exists(p)) plcs.push({ ...(await loadPlcProject(p)), tcVersion });
  }
  return { file, name: path.basename(file).replace(/\.tsp?proj$/i, ''), plcOnly: /\.tspproj$/i.test(file), tcVersion, plcs };
}

export async function loadPlcProject(file: string): Promise<PlcProject> {
  const text = await read(file);
  const root = parseXml(text);
  const dir = path.dirname(file);
  const all = [...walk(root)];
  const prop = (name: string) => textOf(all.find(n => n.name === name && n.children.length === 0), text);

  const folders = all.filter(n => n.name === 'Folder' && n.attrs.Include).map(n => toPosix(n.attrs.Include).replace(/\/$/, ''));
  const objects: PlcObject[] = [];
  for (const n of all.filter(n => n.name === 'Compile' && n.attrs.Include)) {
    const rel = toPosix(n.attrs.Include);
    const abs = path.join(dir, rel);
    objects.push(await describeObject(abs, rel));
  }

  const pinned = new Map<string, LibraryId>();
  for (const n of all.filter(n => n.name === 'PlaceholderResolution')) {
    const id = parseLibraryId(textOf(child(n, 'Resolution'), text));
    if (id) pinned.set((n.attrs.Include ?? id.name).toLowerCase(), id);
  }
  const references: LibraryRef[] = [];
  for (const n of all) {
    if (n.name === 'PlaceholderReference') {
      const def = parseLibraryId(textOf(child(n, 'DefaultResolution'), text));
      if (!def) continue;
      const key = n.attrs.Include ?? def.name;
      const pin = pinned.get(key.toLowerCase());
      references.push({ placeholder: key, kind: 'placeholder', default: def, pinned: pin, effective: pin ?? def });
    } else if (n.name === 'LibraryReference') {
      const id = parseLibraryId(n.attrs.Include);
      if (id) references.push({ placeholder: textOf(child(n, 'Namespace'), text) ?? id.name, kind: 'library', default: id, effective: id });
    }
  }

  const title = prop('Title'), company = prop('Company'), version = prop('ProjectVersion');
  return {
    file, dir,
    name: prop('Name') ?? path.basename(file, '.plcproj'),
    title, company, version,
    isLibrary: !!(title && company && version),
    folders, objects, references,
  };
}

/** TwinCAT writes protected object files as binary starting with this marker. */
export const isEncrypted = (text: string) => text.startsWith('TcEncryptedFile');

export function parseLibraryId(s: string | undefined): LibraryId | undefined {
  const m = s && /^\s*([^,]+?)\s*,\s*(\S+)\s*\(([^)]+)\)\s*$/.exec(s);
  return m ? { name: m[1], version: m[2], vendor: m[3].trim() } : undefined;
}

export const formatLibraryId = (id: LibraryId) => `${id.name}, ${id.version} (${id.vendor})`;

const EXT_TYPE: Record<string, ObjectType> = { '.tcgvl': 'GVL', '.tcio': 'INTERFACE', '.tctto': 'TASK' };

/** Reads name and kind of an object file from its first declaration (cheap: a regex on the file head). */
export async function describeObject(abs: string, rel: string): Promise<PlcObject> {
  const ext = path.extname(abs).toLowerCase();
  const base: PlcObject = { rel, file: abs, name: path.basename(abs, path.extname(abs)), type: EXT_TYPE[ext] ?? 'OTHER' };
  let text: string;
  try { text = await read(abs); } catch { return base; }
  if (isEncrypted(text)) return { ...base, encrypted: true };
  const nameAttr = /<(?:POU|DUT|GVL|Itf|Task)\s+Name="([^"]+)"/.exec(text);
  if (nameAttr) base.name = nameAttr[1];
  const decl = /<Declaration><!\[CDATA\[([\s\S]*?)\]\]>/.exec(text)?.[1] ?? '';
  const code = decl.replace(/\(\*[\s\S]*?\*\)|\/\/.*$|\{[^}]*\}/gm, ' ');
  if (ext === '.tcpou') {
    const m = /\b(FUNCTION_BLOCK|PROGRAM|FUNCTION)\b/i.exec(code);
    if (m) base.type = m[1].toUpperCase() as ObjectType;
  } else if (ext === '.tcdut') {
    base.type = /\bSTRUCT\b/i.test(code) ? 'STRUCT' : /\bUNION\b/i.test(code) ? 'UNION' : /:\s*\(/.test(code) || /\)\s*(?:\w+\s*)?;?\s*END_TYPE/i.test(code) ? 'ENUM' : 'ALIAS';
  }
  const ext_ = /\bEXTENDS\s+([\w.,\s]+?)(?=\s+IMPLEMENTS\b|\s*$|\s+VAR|\n)/i.exec(code);
  if (ext_) base.extends = ext_[1].trim();
  const impl = /\bIMPLEMENTS\s+([\w.,\s]+?)(?=\s*$|\s+VAR|\n)/i.exec(code);
  if (impl) base.implements = impl[1].split(',').map(s => s.trim()).filter(Boolean);
  return base;
}

/** Members of a POU or interface file: methods, properties (with accessors), actions, transitions. */
export interface Member { kind: 'METHOD' | 'PROPERTY' | 'ACTION' | 'TRANSITION'; name: string; signature: string; get?: boolean; set?: boolean }

const MEMBER_KIND: Record<string, Member['kind'] | undefined> = { Method: 'METHOD', Property: 'PROPERTY', Action: 'ACTION', Transition: 'TRANSITION' };

export function listMembers(xml: string): Member[] {
  const root = parseXml(stripBom(xml));
  const obj = child(root, 'TcPlcObject');
  const main = obj?.children.find(c => ['POU', 'Itf'].includes(c.name));
  if (!main) return [];
  const out: Member[] = [];
  const decl = (n: XNode) => {
    const d = child(n, 'Declaration');
    return (d && cdataText(d)) ?? '';
  };
  const firstLine = (s: string) => s.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('{'))?.trim() ?? '';
  for (const c of main.children) {
    const kind = MEMBER_KIND[c.name];
    if (!kind || !c.attrs.Name) continue;
    const m: Member = { kind, name: c.attrs.Name, signature: firstLine(decl(c)) };
    if (kind === 'PROPERTY') { m.get = !!child(c, 'Get'); m.set = !!child(c, 'Set'); }
    out.push(m);
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'out', '.vs']);

/** Finds files with the given extensions below a folder, skipping TwinCAT output (_*) and tool folders. */
export async function findFiles(root: string, exts: string[], maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  const want = exts.map(e => e.toLowerCase());
  async function visit(dir: string, depth: number) {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith('_') && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await visit(p, depth + 1);
      } else if (want.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await visit(root, 0);
  return out.sort();
}
