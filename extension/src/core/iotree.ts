// IO links of a TwinCAT system project as a hardware tree (device > box > terminal > channel), in the
// format of the HardwareLinks.yaml of the Timaris hardware links tool:
//
//   Device 1 TM (EtherCAT):
//     -KF2.0 (EK1100):
//       -KF2.11 (EL1809):
//         Channel 1: Plc^MAIN.stDevices.fbBT1.stIO.IbOn
//
// Links are read from the active <Mappings> of the .tsproj and of the .xti files it references (directly
// or through other .xti files). Owner names in an .xti are relative to the item the file holds, so they
// are resolved along that reference chain. Unreferenced .xti files and <UnrestoredVarLinks> are ignored.

import * as path from 'path';
import { parseXml, XNode, child } from '../xml';

/** Reads a file (working copy or a commit); undefined if it doesn't exist. */
export type FileReader = (file: string) => Promise<string | undefined>;

/** One link, oriented like the hardware links tool: the PLC side left, otherwise the ordinally smaller side left. */
export interface HwLink {
  left: string;
  right: string;
  size?: string;
  offsLeft?: string;
  offsRight?: string;
  /** Link attributes besides VarA / VarB, as stored (Size, OffsA, OffsB …). */
  attrs: Record<string, string>;
  /** Side A as stored (VarA), to map attrs like OffsA to a side. */
  sideA: string;
  /** File the link is stored in, relative to the project folder. */
  file: string;
}

interface LinkFile { path: string; category?: string; itemPath?: string; doc: Doc }
interface Doc { src: string; root: XNode | undefined }

const CATEGORY_BY_PARENT: Record<string, string> = { Io: 'IO', Safety: 'SPLC', Plc: 'PLC' };

function* walk(n: XNode): Generator<XNode> { for (const c of n.children) { yield c; yield* walk(c); } }

const unescapeText = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, x, n) => String.fromCodePoint(parseInt(n, x ? 16 : 10))).replace(/&amp;/g, '&');
const text = (doc: Doc, n: XNode | undefined) => (n ? unescapeText(doc.src.slice(n.innerStart, n.innerEnd)).trim() : '');
const hasAncestor = (n: XNode, name: string) => { for (let a = n.parent; a; a = a.parent) if (a.name === name) return true; return false; };

function load(src: string): Doc {
  const root = parseXml(src.replace(/^﻿/, '')).children.find(c => !c.name.startsWith('?'));
  return { src: src.replace(/^﻿/, ''), root };
}

/** TwinCAT writes characters that are invalid in file names as %_XX. */
const fromFileName = (file: string) => path.basename(file, path.extname(file)).replace(/%_([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const toFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, c => '%_' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

function itemName(doc: Doc, file: string): string {
  const own = doc.root?.children.map(c => child(c, 'Name')).find(n => n);
  const name = text(doc, own);
  return !name || name === '__FILENAME__' ? fromFileName(file) : name;
}

function fileReferences(doc: Doc, isProject: boolean): XNode[] {
  const top = isProject ? doc.root && child(doc.root, 'Project') : doc.root;
  if (!top) return [];
  const all = isProject ? [...walk(top)] : [top, ...walk(top)];
  return all.filter(e => e.attrs.File !== undefined && e.name !== 'AdditionalTmcFile' && (isProject || !hasAncestor(e, 'Mappings')));
}

async function addFile(file: string, category: string, parentItemPath: string | undefined, ctx: SetContext): Promise<void> {
  const src = await ctx.read(file);
  if (src === undefined) { ctx.warnings.push(`Referenced file not found: ${path.relative(ctx.dir, file)}`); return; }
  const full = path.resolve(file);
  if (ctx.visited.has(full.toLowerCase())) return;
  ctx.visited.add(full.toLowerCase());
  const doc = load(src);
  const name = itemName(doc, full);
  let itemPath: string;
  if (parentItemPath) itemPath = `${parentItemPath}^${name}`;
  else if (category === 'IO') itemPath = `TIID^${name}`;
  else if (category === 'NC') {
    // NC.xti writes its owners relative to the NC task, the .tsproj spells the task out.
    const nc = doc.root && child(doc.root, 'NC');
    const task = text(doc, nc?.children.map(c => child(c, 'Name')).find(n => n));
    itemPath = task ? `TINC^${task}` : 'TINC';
  } else if (category === 'PLC') itemPath = `TIPC^${name}`;
  else itemPath = name;
  ctx.files.push({ path: full, category, itemPath, doc });

  const folder = path.join(path.dirname(full), path.basename(full, path.extname(full)));
  for (const el of fileReferences(doc, false)) {
    // A file box inside inline boxes (coupler > junction > drive) lives in one subfolder per inline box.
    const inline: string[] = [];
    for (let a = el.parent; a?.parent && a.parent.name !== 'TcSmItem'; a = a.parent) {
      if (a.name !== 'Box' || a.attrs.File !== undefined) continue;
      const n = text(doc, child(a, 'Name'));
      if (n && n !== '__FILENAME__') inline.unshift(n);
    }
    let dir = path.join(folder, ...inline.map(toFileName));
    if (category === 'NC' && el.name === 'Axis') {
      // NC.xti keeps its axis files in _Config/NC/Axes, and their links belong to <task>^Axes^<axis>.
      dir = path.join(path.dirname(full), 'Axes');
      inline.unshift('Axes');
    }
    // A PLC project keeps its instance file next to itself (_Config/PLC/Plc Instance.xti).
    if (category === 'PLC' && el.name === 'Instance') dir = path.dirname(full);
    await addFile(path.join(dir, el.attrs.File), category, [itemPath, ...inline].join('^'), ctx);
  }
}

interface SetContext { dir: string; read: FileReader; visited: Set<string>; files: LinkFile[]; warnings: string[] }

/** The .tsproj and every .xti it references, with the item path its relative owner names start from. */
async function linkFileSet(tsproj: string, read: FileReader, warnings: string[]): Promise<LinkFile[]> {
  const full = path.resolve(tsproj);
  const src = await read(full);
  if (src === undefined) return [];
  const doc = load(src);
  const ctx: SetContext = { dir: path.dirname(full), read, visited: new Set([full.toLowerCase()]), files: [{ path: full, doc }], warnings };
  for (const el of fileReferences(doc, true)) {
    const category = el.name === 'NC' ? 'NC' : CATEGORY_BY_PARENT[el.parent?.name ?? ''];
    if (!category) continue;
    await addFile(path.join(ctx.dir, '_Config', category, el.attrs.File), category, undefined, ctx);
  }
  return ctx.files;
}

function resolveOwner(raw: string, itemPath: string | undefined): string {
  if (/^TI[A-Z]+\^/.test(raw) || !itemPath) return raw;
  return raw === '' ? itemPath : `${itemPath}^${raw}`;
}
const joinSide = (owner: string, v: string) => (owner ? `${owner}^${v}` : v);
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Links of one file's active <Mappings>; `itemPath` resolves relative owner names (undefined for a .tsproj). */
export function linksOfFile(src: string, file: string, itemPath?: string): HwLink[] {
  return linksOfDoc(load(src), file, itemPath);
}

function linksOfDoc(doc: Doc, file: string, itemPath?: string): HwLink[] {
  const out: HwLink[] = [];
  const mappings = doc.root?.children.filter(c => c.name === 'Mappings') ?? [];
  for (const m of mappings) for (const a of m.children) {
    if (a.name !== 'OwnerA') continue;
    for (const b of a.children) {
      if (b.name !== 'OwnerB') continue;
      for (const l of b.children) {
        if (l.name !== 'Link') continue;
        const { VarA = '', VarB = '', ...attrs } = l.attrs;
        const ownerA = resolveOwner(a.attrs.Name ?? '', itemPath), ownerB = resolveOwner(b.attrs.Name ?? '', itemPath);
        const sideA = joinSide(ownerA, VarA), sideB = joinSide(ownerB, VarB);
        const aPlc = sideA.startsWith('TIPC^'), bPlc = sideB.startsWith('TIPC^');
        const swap = aPlc !== bPlc ? bPlc : ordinal(sideB, sideA) < 0;
        out.push({
          left: swap ? sideB : sideA, right: swap ? sideA : sideB, size: attrs.Size,
          offsLeft: swap ? attrs.OffsB : attrs.OffsA, offsRight: swap ? attrs.OffsA : attrs.OffsB,
          attrs, sideA, file,
        });
      }
    }
  }
  return out;
}

/** One-line form of a link; also the key that makes links unique. */
export function linkLine(l: HwLink): string {
  const bits = [l.size !== undefined && `Size=${l.size}`, l.offsLeft !== undefined && `OffsLeft=${l.offsLeft}`, l.offsRight !== undefined && `OffsRight=${l.offsRight}`].filter(Boolean);
  return `${l.left} <-> ${l.right}` + (bits.length ? ` [${bits.join(' ')}]` : '');
}

/** Every box of the IO files as a full path (TIID^device^box^…): the nesting levels of the tree. */
function boxCatalog(files: LinkFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (f.category !== 'IO' || !f.doc.root) continue;
    out.add(f.itemPath!);
    for (const top of f.doc.root.children) for (const box of walk(top)) {
      if (box.name !== 'Box' || box.attrs.File !== undefined || hasAncestor(box, 'Mappings')) continue;
      const nameNode = child(box, 'Name');
      if (!nameNode) continue;
      const own = text(f.doc, nameNode);
      if (!own || own === '__FILENAME__') continue;
      const names = [own];
      let complete = true;
      for (let a = box.parent; a && a.parent && a.parent.name !== 'TcSmItem'; a = a.parent) {
        if (a.name !== 'Box') continue;
        const n = text(f.doc, child(a, 'Name'));
        if (n) names.unshift(n); else complete = false;
      }
      if (complete) out.add(`${f.itemPath}^${names.join('^')}`);
    }
  }
  return [...out].sort(ordinal);
}

export interface IoSnapshot { links: HwLink[]; boxes: string[]; warnings: string[] }

/** All links of a system project (sorted, without duplicates) and the box catalog of its IO tree. */
export async function readProject(tsproj: string, read: FileReader): Promise<IoSnapshot> {
  const warnings: string[] = [];
  const files = await linkFileSet(tsproj, read, warnings);
  const dir = path.dirname(path.resolve(tsproj));
  const unique = new Map<string, HwLink>();
  for (const f of files) {
    const rel = path.relative(dir, f.path).split(path.sep).join('/');
    for (const l of linksOfDoc(f.doc, rel, f.itemPath)) {
      const key = linkLine(l);
      if (!unique.has(key)) unique.set(key, l);
    }
  }
  const links = [...unique.entries()].sort((a, b) => ordinal(a[0], b[0])).map(e => e[1]);
  return { links, boxes: boxCatalog(files), warnings };
}

// ---------------------------------------------------------------------------------------------
// Tree

/** Short display names: Plc^MAIN.x for PLC variables, NC^… for NC, the device path without TIID^ for IO. */
export function shortName(s: string): string {
  let m = /^TIPC\^([^^]+)\^\1 Instance\^[^^]+ (?:Inputs|Outputs)\^(.+)$/.exec(s);
  if (m) return `${m[1]}^${m[2]}`;
  if ((m = /^TIPC\^(.+)$/.exec(s))) return m[1];
  if ((m = /^TINC\^(.*)$/.exec(s))) return `NC^${m[1]}`;
  if ((m = /^TIID\^(.*)$/.exec(s))) return m[1];
  return s;
}

const SAFETY = /\^(?:ConnectionInputs|ConnectionOutputs|StandardInputs|StandardOutputs)\^/;

/** Which side is the place in the tree (usually the IO channel) and which is the linked value. */
function grouping(l: HwLink) {
  const leftIo = l.left.startsWith('TIID^'), rightIo = l.right.startsWith('TIID^');
  let groupRight = true;
  if (l.left.startsWith('TIPC^')) groupRight = true;
  // IO to IO: the TwinSAFE logic terminal groups its safety links.
  else if (leftIo && rightIo) groupRight = !(SAFETY.test(l.left) && !SAFETY.test(l.right));
  else if (leftIo !== rightIo) groupRight = rightIo;
  return groupRight
    ? { group: l.right, linked: l.left, groupOffs: l.offsRight, linkedOffs: l.offsLeft }
    : { group: l.left, linked: l.right, groupOffs: l.offsLeft, linkedOffs: l.offsRight };
}

/** Splits the place into nested keys (devices, boxes) and the leaf key (channel). */
function splitPlace(side: string, ioBoxes: Set<string>): { keys: string[]; leaf: string } {
  const t = shortName(side);
  const keys: string[] = [];
  let start = 0;
  if (side.startsWith('TIID^')) {
    // Every box of the catalogue on the way is a nested key; the rest after the deepest box is the leaf key.
    for (let i = t.indexOf('^'); i >= 0; i = t.indexOf('^', i + 1))
      if (ioBoxes.has(t.slice(0, i))) { keys.push(t.slice(start, i)); start = i + 1; }
    if (!keys.length) {
      const first = t.indexOf('^');
      if (first > 0) { keys.push(t.slice(0, first)); start = first + 1; }
    }
  } else if (side.startsWith('TINC^')) {
    let m: RegExpExecArray | null;
    if ((m = /^NC\^([^^]+)\^Axes\^([^^]+)\^.+$/.exec(t))) keys.push('NC', m[1], 'Axes', m[2]);
    else if ((m = /^NC\^([^^]+)\^.+$/.exec(t))) keys.push('NC', m[1]);
    else keys.push('NC');
    start = keys.join('^').length + 1;
  } else {
    const first = t.indexOf('^');
    if (first > 0) { keys.push(t.slice(0, first)); start = first + 1; }
  }
  return { keys, leaf: t.slice(Math.min(start, t.length)) };
}

export interface LinkTree { kids: Map<string, LinkTree>; leaves: Map<string, string[]> }
const newNode = (): LinkTree => ({ kids: new Map(), leaves: new Map() });

/** Builds the hardware tree; each leaf (channel) holds the linked values, e.g. "Plc^MAIN.x [Size=8]". */
export function buildTree(links: HwLink[], boxes: string[]): LinkTree {
  const ioBoxes = new Set(boxes.map(b => (b.startsWith('TIID^') ? b.slice(5) : b)));
  const root = newNode();
  for (const l of links) {
    const g = grouping(l);
    const place = splitPlace(g.group, ioBoxes);
    const linked = shortName(g.linked);
    let leaf = place.leaf;
    if (g.linked.startsWith('TIPC^')) {
      // TwinCAT names many channels after the linked PLC variable: 'Channel 2^MAIN.x' for 'Plc^MAIN.x'.
      const suffix = '^' + linked.slice(linked.indexOf('^') + 1);
      if (leaf.length > suffix.length && leaf.endsWith(suffix)) leaf = leaf.slice(0, leaf.length - suffix.length);
    }
    const bits = [l.size !== undefined && `Size=${l.size}`, g.groupOffs !== undefined && `OffsIO=${g.groupOffs}`, g.linkedOffs !== undefined && `OffsLinked=${g.linkedOffs}`].filter(Boolean);
    const value = bits.length ? `${linked} [${bits.join(' ')}]` : linked;
    let node = root;
    for (const k of place.keys) {
      if (!node.kids.has(k)) node.kids.set(k, newNode());
      node = node.kids.get(k)!;
    }
    if (!node.leaves.has(leaf)) node.leaves.set(leaf, []);
    node.leaves.get(leaf)!.push(value);
  }
  return root;
}

const naturalKey = (s: string) => s.replace(/\d+/g, d => d.padStart(6, '0'));
/** Natural order (Channel 2 before Channel 10), ordinal within equal keys. */
export const naturalSort = (items: string[]) =>
  items.map(s => [naturalKey(s) + '\0' + s, s] as const).sort((a, b) => ordinal(a[0], b[0])).map(x => x[1]);

/** An entry of a tree node in display order: a nested node or a leaf with its values. */
export type TreeEntry = { key: string; node: LinkTree; values?: undefined } | { key: string; values: string[]; node?: undefined };

export function entries(n: LinkTree): TreeEntry[] {
  const all = new Map<string, TreeEntry>();
  for (const [k, node] of n.kids) all.set(k, { key: k, node });
  for (const [k, values] of n.leaves) {
    let key = k;
    while (all.has(key)) key += '^';   // a leaf must not share its key with a box
    all.set(key, { key, values: naturalSort(values) });
  }
  return naturalSort([...all.keys()]).map(k => all.get(k)!);
}

/** Quotes what is not a plain YAML 1.2 string scalar (indicators, ': ', ' #', numbers, booleans). */
export function yamlScalar(s: string): string {
  const numberOrKeyword = /^(?:[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|true|false|null|~|yes|no|on|off|y|n|[-+]?\.inf|\.nan)$/i;
  const unsafe = s === '' || /^\s|\s$/.test(s) || /^[[\]{}&*!|>'"%@`#?,:]/.test(s) || /^-(?:\s|$)/.test(s)
    || s.includes(': ') || s.includes(' #') || s.endsWith(':') || numberOrKeyword.test(s);
  return unsafe ? `'${s.replace(/'/g, "''")}'` : s;
}

export function treeToYaml(tree: LinkTree, header?: string): string {
  const out: string[] = header ? [header] : [];
  const write = (n: LinkTree, depth: number) => {
    const ind = '  '.repeat(depth);
    for (const e of entries(n)) {
      const key = yamlScalar(e.key);
      if (e.node) { out.push(`${ind}${key}:`); write(e.node, depth + 1); }
      else if (e.values.length === 1) out.push(`${ind}${key}: ${yamlScalar(e.values[0])}`);
      else { out.push(`${ind}${key}:`); for (const v of e.values) out.push(`${ind}  - ${yamlScalar(v)}`); }
    }
  };
  write(tree, 0);
  return out.map(l => l + '\n').join('');
}

// ---------------------------------------------------------------------------------------------
// Comparison of two trees

export type ValueState = 'same' | 'added' | 'removed';
export interface DiffValue { text: string; state: ValueState; /** Other place of the same linked value when it moved. */ moved?: string }
export type EntryState = 'same' | 'added' | 'removed' | 'changed';
export interface DiffEntry { key: string; state: EntryState; kids?: DiffEntry[]; values?: DiffValue[] }

/** Linked value without its bit attributes, to recognize a variable that moved to another channel. */
const valueTarget = (v: string) => v.replace(/ \[[^\]]*\]$/, '');

/** Merges two trees; every entry and value carries whether it is unchanged, added or removed. */
export function diffTrees(before: LinkTree, after: LinkTree): DiffEntry[] {
  const merge = (a: LinkTree | undefined, b: LinkTree | undefined, at: string[]): DiffEntry[] => {
    const ea = a ? entries(a) : [], eb = b ? entries(b) : [];
    const id = (e: TreeEntry) => (e.node ? 'n:' : 'l:') + e.key;
    const ma = new Map(ea.map(e => [id(e), e])), mb = new Map(eb.map(e => [id(e), e]));
    const keys = new Map<string, string>();
    for (const e of [...ea, ...eb]) keys.set(id(e), e.key);
    const order = naturalSort([...new Set(keys.values())]);
    const ids = [...keys.keys()].sort((x, y) => order.indexOf(keys.get(x)!) - order.indexOf(keys.get(y)!) || ordinal(x, y));
    return ids.map(i => {
      const x = ma.get(i), y = mb.get(i), key = keys.get(i)!;
      if (i.startsWith('n:')) {
        const kids = merge(x?.node, y?.node, [...at, key]);
        const state: EntryState = !x ? 'added' : !y ? 'removed' : kids.every(k => k.state === 'same') ? 'same' : 'changed';
        return { key, state, kids };
      }
      const va = x?.values ?? [], vb = y?.values ?? [];
      const rest = [...vb];
      const values: DiffValue[] = [];
      for (const v of va) {
        const j = rest.indexOf(v);
        if (j >= 0) { rest.splice(j, 1); values.push({ text: v, state: 'same' }); } else values.push({ text: v, state: 'removed' });
      }
      for (const v of rest) values.push({ text: v, state: 'added' });
      const order2 = naturalSort(values.map(v => v.text));
      values.sort((p, q) => order2.indexOf(p.text) - order2.indexOf(q.text) || (p.state === 'removed' ? -1 : 1));
      const state: EntryState = !x ? 'added' : !y ? 'removed' : values.every(v => v.state === 'same') ? 'same' : 'changed';
      return { key, state, values, path: [...at, key] } as DiffEntry & { path: string[] };
    });
  };
  const result = merge(before, after, []);

  // A value removed at one channel and added at another is a move: note the other place on both.
  const removed = new Map<string, string[]>(), added = new Map<string, string[]>();
  const visit = (es: DiffEntry[], fn: (e: DiffEntry & { path: string[] }) => void) =>
    es.forEach(e => (e.kids ? visit(e.kids, fn) : fn(e as DiffEntry & { path: string[] })));
  visit(result, e => e.values!.forEach(v => {
    const m = v.state === 'removed' ? removed : v.state === 'added' ? added : undefined;
    const t = valueTarget(v.text);
    if (m) m.set(t, [...(m.get(t) ?? []), e.path.join(' › ')]);
  }));
  visit(result, e => {
    const here = e.path.join(' › ');
    for (const v of e.values!) {
      const other = (v.state === 'removed' ? added : v.state === 'added' ? removed : undefined)?.get(valueTarget(v.text))?.filter(p => p !== here);
      if (other?.length) v.moved = other[0];
    }
    delete (e as { path?: string[] }).path;
  });
  return result;
}

/** Number of changed channels, and of added / removed / moved linked values. */
export function diffSummary(es: DiffEntry[]) {
  const s = { channels: 0, added: 0, removed: 0, moved: 0 };
  const visit = (xs: DiffEntry[]) => xs.forEach(e => {
    if (e.kids) return visit(e.kids);
    if (e.state !== 'same') s.channels++;
    for (const v of e.values!) {
      if (v.state === 'same') continue;
      if (v.moved) { if (v.state === 'added') s.moved++; } else s[v.state]++;
    }
  });
  visit(es);
  return s;
}
