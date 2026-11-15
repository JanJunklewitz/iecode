// Reads TwinCAT solutions and PLC projects from disk (no TwinCAT needed):
//   .sln -> .tsproj / .tspproj -> .plcproj -> object files (.TcPOU, .TcDUT, ...)

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseXml, XNode, child, cdataText, escapeAttr } from '../xml';
import { decode, encode, removeMemberFromView } from '../model';

export type ObjectType =
  | 'FUNCTION_BLOCK' | 'PROGRAM' | 'FUNCTION' | 'INTERFACE'
  | 'STRUCT' | 'ENUM' | 'UNION' | 'ALIAS' | 'GVL' | 'TASK' | 'TEXTLIST' | 'IMAGEPOOL' | 'VISUMANAGER' | 'OTHER';

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

/** The .plcproj paths of the <Project PrjFilePath="..."> elements. PLC projects only: a TwinSAFE project (.splcproj) is also one. */
function plcProjectPaths(root: XNode, baseDir: string): string[] {
  return [...walk(root)]
    .filter(n => n.name === 'Project' && /\.plcproj$/i.test(n.attrs.PrjFilePath ?? ''))
    .map(n => path.resolve(baseDir, toPosix(n.attrs.PrjFilePath)));
}

export async function loadTwinCatProject(file: string): Promise<TwinCatProject> {
  const text = await read(file);
  const root = parseXml(text);
  const dir = path.dirname(file);
  const tcVersion = [...walk(root)].find(n => n.attrs.TcVersion)?.attrs.TcVersion;
  const plcs: PlcProject[] = [];
  // inline: <Project PrjFilePath="..."> in the .tsproj; independent: <Plc><Project File="X.xti"/> names a file in _Config/PLC
  // whose own <Project PrjFilePath="..."> is relative to that file
  const paths = plcProjectPaths(root, dir);
  for (const n of walk(root)) {
    if (n.name !== 'Project' || !n.attrs.File || n.attrs.PrjFilePath || !/\.xti$/i.test(n.attrs.File)) continue;
    const xti = path.join(dir, '_Config', 'PLC', toPosix(n.attrs.File));
    if (await exists(xti)) paths.push(...plcProjectPaths(parseXml(await read(xti)), path.dirname(xti)));
  }
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p.toLowerCase()) || !(await exists(p))) continue;
    seen.add(p.toLowerCase());
    plcs.push({ ...(await loadPlcProject(p)), tcVersion });
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

const EXT_TYPE: Record<string, ObjectType> = {
  '.tcgvl': 'GVL', '.tcio': 'INTERFACE', '.tctto': 'TASK', '.tcgtlo': 'TEXTLIST', '.tcipo': 'IMAGEPOOL', '.tcgipo': 'IMAGEPOOL', '.tcvmo': 'VISUMANAGER',
};

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
export interface Member {
  kind: 'METHOD' | 'PROPERTY' | 'ACTION' | 'TRANSITION'; name: string; signature: string; get?: boolean; set?: boolean;
  /** Folder inside the POU (TwinCAT FolderPath, '/'-separated), unset at the top level. */
  folder?: string;
}

/** TwinCAT FolderPath ("Internal\Sub\") to a '/'-separated folder path. */
const folderOf = (fp: string | undefined) => fp?.split('\\').filter(Boolean).join('/') || undefined;

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
    const folder = folderOf(c.attrs.FolderPath);
    if (folder) m.folder = folder;
    if (kind === 'PROPERTY') { m.get = !!child(c, 'Get'); m.set = !!child(c, 'Set'); }
    out.push(m);
  }
  return out;
}

/** Folders inside a POU / interface (declared <Folder> elements and folders named by members' FolderPath), '/'-separated, sorted. */
export function listMemberFolders(xml: string): string[] {
  const root = parseXml(stripBom(xml));
  const main = child(root, 'TcPlcObject')?.children.find(c => ['POU', 'Itf'].includes(c.name));
  if (!main) return [];
  const out = new Set<string>();
  const addWithParents = (f: string | undefined) => { const parts = f?.split('/') ?? []; parts.forEach((_p, i) => out.add(parts.slice(0, i + 1).join('/'))); };
  for (const c of main.children) {
    if (c.name === 'Folder' && c.attrs.Name) addWithParents([folderOf(c.attrs.FolderPath), c.attrs.Name].filter(Boolean).join('/'));
    else if (MEMBER_KIND[c.name]) addWithParents(folderOf(c.attrs.FolderPath));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** How members are shown below a POU: in its TwinCAT folders, grouped by kind, or as one list. */
export type MemberGrouping = 'folders' | 'kind' | 'none';
const MEMBER_KINDS: Member['kind'][] = ['METHOD', 'PROPERTY', 'ACTION', 'TRANSITION'];

/** Children of a POU (or of one of its folders, `rel`): sub folders first, then members, both by name. */
export function memberLevel(members: Member[], folders: string[], rel: string, grouping: MemberGrouping): { folders: string[]; members: Member[] } {
  const byName = (a: Member, b: Member) => a.name.localeCompare(b.name);
  if (grouping === 'none') return { folders: [], members: rel ? [] : [...members] };
  if (grouping === 'kind') {
    if (!rel) return { folders: MEMBER_KINDS.filter(k => members.some(m => m.kind === k)).map(k => '#' + k), members: [] };
    return { folders: [], members: members.filter(m => '#' + m.kind === rel).sort(byName) };
  }
  const prefix = rel ? rel + '/' : '';
  const sub = new Set<string>();
  for (const f of folders) if (f.startsWith(prefix) && f !== rel) sub.add(prefix + f.slice(prefix.length).split('/')[0]);
  return { folders: [...sub].sort((a, b) => a.localeCompare(b)), members: members.filter(m => (m.folder ?? '') === rel).sort(byName) };
}

const toFolderPath = (folder: string) => folder.split('/').filter(Boolean).map(p => p + '\\').join('');

/** Adds a <Folder> element to a POU / interface ('/'-separated path; a nested folder carries its parent as FolderPath). */
export function addMemberFolder(xml: string, folder: string, id: string): string {
  const bom = xml.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const src = stripBom(xml);
  if (listMemberFolders(src).some(f => f.toLowerCase() === folder.toLowerCase())) throw new Error(`Folder ${folder} already exists`);
  const main = child(parseXml(src), 'TcPlcObject')?.children.find(c => ['POU', 'Itf'].includes(c.name));
  if (!main) throw new Error('Folders can only be added to POUs and interfaces');
  const parts = folder.split('/');
  const name = parts.pop()!;
  const parent = parts.join('/');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  // TwinCAT writes folders after the implementation, before the members
  const anchor = main.children.find(c => c.name === 'Folder' || MEMBER_KIND[c.name] || c.name === 'LineIds');
  const lineStart = (pos: number) => src.lastIndexOf('\n', pos - 1) + 1;
  const at = anchor ? lineStart(anchor.start) : lineStart(main.innerEnd);
  const indent = anchor ? src.slice(lineStart(anchor.start), anchor.start) : src.slice(lineStart(main.start), main.start) + '  ';
  const el = `${indent}<Folder Name="${escapeAttr(name)}" Id="${id}"${parent ? ` FolderPath="${escapeAttr(toFolderPath(parent))}"` : ''} />${eol}`;
  return bom + src.slice(0, at) + el + src.slice(at);
}

interface Splice { start: number; end: number; text: string }
const applySplices = (src: string, edits: Splice[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), src);

/** The main POU / Itf node of an object file (BOM stripped). */
function pouNode(src: string): XNode {
  const main = child(parseXml(src), 'TcPlcObject')?.children.find(c => ['POU', 'Itf'].includes(c.name));
  if (!main) throw new Error('Folders exist only in POUs and interfaces');
  return main;
}

/** Splice that sets (or with '' removes) the FolderPath attribute in a node's start tag; `name` also replaces the Name attribute. */
function retag(src: string, node: XNode, folder: string, name?: string): Splice {
  const tagEnd = node.innerStart - 1;   // the start tag's '>'
  let tag = src.slice(node.start, tagEnd);
  const closing = tag.endsWith('/');
  if (closing) tag = tag.slice(0, -1).trimEnd();
  tag = tag.replace(/\s+FolderPath="[^"]*"/, '');
  if (name !== undefined) tag = tag.replace(/(\sName=")[^"]*(")/, `$1${escapeAttr(name)}$2`);
  if (folder) tag += ` FolderPath="${escapeAttr(toFolderPath(folder))}"`;
  return { start: node.start, end: tagEnd, text: tag + (closing ? ' /' : '') };
}

/** Splice that removes a node with its line. */
function removeLine(src: string, node: XNode): Splice {
  const start = src.lastIndexOf('\n', node.start - 1) + 1;
  let end = node.end;
  if (src.startsWith('\r\n', end)) end += 2; else if (src[end] === '\n') end += 1;
  return { start, end, text: '' };
}

/** Folder path of a <Folder> element itself. */
const folderPathOf = (n: XNode) => [folderOf(n.attrs.FolderPath), n.attrs.Name].filter(Boolean).join('/');
const lower = (s: string) => s.toLowerCase();
const isUnder = (path: string | undefined, folder: string) => !!path && (lower(path) === lower(folder) || lower(path).startsWith(lower(folder) + '/'));
/** `path` (inside `from`) moved to `to`: from/rest → to/rest. */
const rebase = (path: string, from: string, to: string) => [to, path.slice(from.length + 1)].filter(Boolean).join('/');

/** Moves a member (method / property / action / transition) into a folder of its POU, or to the top level ('' folder). */
export function moveMemberToFolder(xml: string, kind: Member['kind'], name: string, folder: string): string {
  const bom = xml.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const src = stripBom(xml);
  const node = pouNode(src).children.find(c => MEMBER_KIND[c.name] === kind && c.attrs.Name === name);
  if (!node) throw new Error(`${kind.toLowerCase()} ${name} not found`);
  return bom + applySplices(src, [retag(src, node, folder)]);
}

/** Renames a folder inside a POU / interface: its <Folder> element and the FolderPath of everything in it (sub folders included). */
export function renameMemberFolder(xml: string, folder: string, newName: string): string {
  if (!newName || /[\\/]/.test(newName)) throw new Error(`'${newName}' is not a valid folder name`);
  const bom = xml.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const src = stripBom(xml);
  const folders = listMemberFolders(src);
  if (!folders.some(f => lower(f) === lower(folder))) throw new Error(`Folder ${folder} not found`);
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  const target = parent ? `${parent}/${newName}` : newName;
  if (lower(target) !== lower(folder) && folders.some(f => lower(f) === lower(target))) throw new Error(`Folder ${target} already exists`);
  const edits: Splice[] = [];
  for (const c of pouNode(src).children) {
    const own = folderOf(c.attrs.FolderPath);
    if (c.name === 'Folder' && lower(folderPathOf(c)) === lower(folder)) edits.push(retag(src, c, parent, newName));
    else if ((c.name === 'Folder' || MEMBER_KIND[c.name]) && isUnder(own, folder)) edits.push(retag(src, c, rebase(own!, folder, target)));
  }
  return bom + applySplices(src, edits);
}

/**
 * Deletes a folder inside a POU / interface. `deleteMembers` false: its members and sub folders move up into the parent
 * folder. true: the members in it (and in its sub folders) are deleted with it, a property with its GET / SET.
 */
export function deleteMemberFolder(xml: string, folder: string, deleteMembers: boolean): string {
  const bom = xml.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  let src = stripBom(xml);
  if (!listMemberFolders(src).some(f => lower(f) === lower(folder))) throw new Error(`Folder ${folder} not found`);
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
  if (deleteMembers) {
    // through the view, so LineIds and accessors go too
    let view = decode(src);
    for (const m of listMembers(src)) if (isUnder(m.folder, folder)) view = removeMemberFromView(view, m.kind, m.name);
    src = encode(src, view);
  }
  const children = pouNode(src).children;
  const existing = new Set(children.filter(c => c.name === 'Folder' && !isUnder(folderPathOf(c), folder)).map(c => lower(folderPathOf(c))));
  const edits: Splice[] = [];
  for (const c of children) {
    const own = folderOf(c.attrs.FolderPath);
    if (c.name === 'Folder') {
      const path = folderPathOf(c);
      if (!isUnder(path, folder)) continue;
      const moved = lower(path) === lower(folder) ? undefined : rebase(path, folder, parent);
      // the folder itself goes; a sub folder goes too when deleted with its members or when the parent already has one of that name
      if (!moved || deleteMembers || existing.has(lower(moved))) edits.push(removeLine(src, c));
      else { existing.add(lower(moved)); edits.push(retag(src, c, rebase(own!, folder, parent))); }
    } else if (MEMBER_KIND[c.name] && isUnder(own, folder)) {
      edits.push(retag(src, c, rebase(own!, folder, parent)));
    }
  }
  return bom + applySplices(src, edits);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'out', '.vs']);

/** Finds files with the given extensions below a folder, skipping TwinCAT output (_*) and tool folders.
 *  `underscore` also visits _* folders (e.g. _Config, where TwinCAT keeps independent IO files). */
export async function findFiles(root: string, exts: string[], maxDepth = 6, underscore = false): Promise<string[]> {
  const out: string[] = [];
  const want = exts.map(e => e.toLowerCase());
  async function visit(dir: string, depth: number) {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && (underscore || !e.name.startsWith('_')) && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await visit(p, depth + 1);
      } else if (want.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await visit(root, 0);
  return out.sort();
}
