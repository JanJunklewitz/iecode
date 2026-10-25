// ADS interface (symbol table) of a PLC project without a running PLC, from two sources:
//
// - Build output: the TwinCAT Module Class file <PLC>.tmc that every build writes next to the .plcproj.
//   Exact (library types, sizes, data areas):
//     <DataTypes><DataType><Name>FB_Motor</Name><SubItem><Name>bEnable</Name><Type>BOOL</Type>…
//     <Modules><Module><DataAreas><DataArea><Name>PlcTask Internal</Name>
//       <Symbol><Name>MAIN.fbMotor</Name><BitSize>192</BitSize><BaseType>FB_Motor</BaseType>…
// - Source code (no build): GVL and PROGRAM variables from the declarations, expanded with the
//   function blocks and structs of the project. No sizes; types from libraries are not expanded.
//
// Same rules as the iecode CLI (IECode.Core/Projects/AdsInterface.cs).

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseXml, XNode, cdataText } from '../xml';
import { decode } from '../model';
import { SymbolIndex, IndexedObject } from '../lang/index';
import { PlcSymbol } from '../lang/parser';
import { isEncrypted, PlcProject } from './projects';
import { filesAt, repoRoot, show } from './git';

export interface AdsSymbol {
  /** Full ADS name, e.g. MAIN.fbMotor.bEnable or GVL_IO.aValues. */
  name: string;
  type: string;
  /** Size in bits (build output only). */
  bitSize?: number;
  comment?: string;
  /** Build output: data area ("PlcTask Inputs" …); source: declaration block ("VAR_GLOBAL" …). */
  area?: string;
}

export interface AdsInterface {
  origin: 'build' | 'source';
  symbols: AdsSymbol[];
  /** The .tmc the symbols were read from (build output). */
  file?: string;
  /** Build output older than the source files. */
  stale?: boolean;
  /** Source: names of the GVLs and programs (the first part of every symbol name). */
  roots?: string[];
}

export type AdsChangeKind = 'added' | 'removed' | 'changed';
export interface AdsChange { kind: AdsChangeKind; name: string; before?: string; after?: string; details?: string }

export const SNAPSHOT_FORMAT = 'iecode-ads-interface/1';
const MAX_DEPTH = 8;
const U = (s: string) => s.toUpperCase();

export const sizeText = (bits?: number) => (bits === undefined ? '' : bits % 8 === 0 ? `${bits / 8} B` : `${bits} bit`);

// ---- build output (.tmc) ----

const kids = (n: XNode, name: string) => n.children.filter(c => c.name === name);
const kid = (n: XNode, name: string) => n.children.find(c => c.name === name);

function* walk(n: XNode): Generator<XNode> { for (const c of n.children) { yield c; yield* walk(c); } }

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function textOf(n: XNode | undefined, src: string): string | undefined {
  if (!n) return undefined;
  const raw = cdataText(n) ?? src.slice(n.innerStart, n.innerEnd).replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);
  return raw.trim() || undefined;
}

const intOf = (n: XNode | undefined, src: string) => {
  const t = textOf(n, src);
  return t !== undefined && /^-?\d+$/.test(t) ? Number(t) : undefined;
};

const keyOf = (n: XNode | undefined, src: string) => {
  const t = textOf(n, src) ?? '';
  return n?.attrs.Namespace ? `${n.attrs.Namespace}.${t}` : t;
};

/** Type of a symbol / member: base type plus ARRAY / POINTER TO / REFERENCE TO. */
function typeOf(n: XNode, typeElement: string, src: string): string {
  const t = kid(n, typeElement);
  let type = textOf(t, src) ?? '';
  if (t?.attrs.PointerTo) type = 'POINTER TO '.repeat(Math.max(Number(t.attrs.PointerTo) || 1, 1)) + type;
  if (t?.attrs.ReferenceTo) type = 'REFERENCE TO ' + type;
  const dims = kids(n, 'ArrayInfo').map(a => {
    const lb = intOf(kid(a, 'LBound'), src) ?? 0;
    return `${lb}..${lb + (intOf(kid(a, 'Elements'), src) ?? 0) - 1}`;
  });
  return dims.length ? `ARRAY [${dims.join(', ')}] OF ${type}` : type;
}

interface TmcMember { name: string; type: string; bitSize?: number; comment?: string }
interface TmcType { name: string; members: TmcMember[]; extends?: string; alias?: string }

/** Symbols of a .tmc file; `members` expands structs and function blocks (not arrays and pointers). */
export function fromTmc(xml: string, members = false): AdsSymbol[] {
  const src = xml.replace(/^﻿/, '');
  const root = parseXml(src);
  const types = new Map<string, TmcType>();
  for (const dt of walk(root)) {
    if (dt.name !== 'DataType' || dt.parent?.name !== 'DataTypes') continue;
    const name = kid(dt, 'Name');
    if (!name) continue;
    const items = kids(dt, 'SubItem').filter(s => textOf(kid(s, 'Name'), src))
      .map(s => ({ name: textOf(kid(s, 'Name'), src)!, type: typeOf(s, 'Type', src), bitSize: intOf(kid(s, 'BitSize'), src), comment: textOf(kid(s, 'Comment'), src) }));
    const alias = !kid(dt, 'ArrayInfo') && !items.length ? keyOf(kid(dt, 'BaseType'), src) || undefined : undefined;
    const type: TmcType = { name: textOf(name, src) ?? '', members: items, extends: keyOf(kid(dt, 'ExtendsType'), src) || undefined, alias };
    for (const k of [keyOf(name, src), type.name]) if (!types.has(U(k))) types.set(U(k), type);
  }

  const membersOf = (key: string, visited: Set<string>): TmcMember[] => {
    const t = types.get(U(key));
    if (!t || visited.has(U(t.name))) return [];
    visited.add(U(t.name));
    if (t.alias) return membersOf(t.alias, visited);
    return [...(t.extends ? membersOf(t.extends, visited) : []), ...t.members];
  };

  const out: AdsSymbol[] = [];
  const seen = new Set<string>();
  const add = (s: AdsSymbol) => { if (seen.has(U(s.name))) return false; seen.add(U(s.name)); out.push(s); return true; };
  const expand = (parent: string, typeKey: string, area: string | undefined, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const m of membersOf(typeKey, new Set())) {
      const name = `${parent}.${m.name}`;
      if (add({ name, type: m.type, bitSize: m.bitSize, comment: m.comment, area }) && types.has(U(m.type))) expand(name, m.type, area, depth + 1);
    }
  };

  for (const s of walk(root)) {
    if (s.name !== 'Symbol' || s.parent?.name !== 'DataArea') continue;
    const name = textOf(kid(s, 'Name'), src);
    if (!name) continue;
    const area = textOf(kid(s.parent, 'Name'), src);
    const type = typeOf(s, 'BaseType', src);
    if (!add({ name, type, bitSize: intOf(kid(s, 'BitSize'), src), comment: textOf(kid(s, 'Comment'), src), area })) continue;
    if (members && type === (textOf(kid(s, 'BaseType'), src) ?? '')) expand(name, keyOf(kid(s, 'BaseType'), src), area, 1);
  }
  return byName(out);
}

const byName = (s: AdsSymbol[]) => s.sort((a, b) => U(a.name) < U(b.name) ? -1 : U(a.name) > U(b.name) ? 1 : 0);

// ---- source code ----

const HIDDEN = new Set(['VAR_TEMP', 'VAR_STAT', 'VAR_INST', 'VAR_EXTERNAL', 'VAR_CONFIG']);

/** Whether a declared variable becomes an ADS symbol: no temporaries, statics, constants or {attribute 'hide'}. */
function visible(v: PlcSymbol, obj: IndexedObject): boolean {
  if (v.kind !== 'VARIABLE' && v.kind !== 'FIELD') return false;
  if (v.scope && HIDDEN.has(v.scope)) return false;
  if (v.modifiers?.includes('CONSTANT')) return false;
  const lines = obj.view.split('\n');
  const hide = /\{\s*attribute\s+'hide'\s*\}/i;
  if (hide.test(lines[v.range.line]?.slice(0, v.range.col) ?? '')) return false;
  for (let l = v.range.line - 1; l >= 0; l--) {
    const t = lines[l].trim();
    if (!t.startsWith('{')) break;
    if (hide.test(t)) return false;
  }
  return true;
}

/** Comment of a declaration: after it on the same line, or // lines directly above. */
function commentOf(v: PlcSymbol, obj: IndexedObject): string | undefined {
  const lines = obj.view.split('\n');
  const after = /;\s*(?:\/\/(.*)|\(\*([\s\S]*?)\*\))\s*$/.exec(lines[v.range.line] ?? '');
  if (after) return (after[1] ?? after[2]).trim() || undefined;
  const above: string[] = [];
  for (let l = v.range.line - 1; l >= 0 && /^\s*\/\//.test(lines[l]); l--) above.unshift(lines[l].trim().replace(/^\/\/\s?/, ''));
  return above.join('\n').trim() || undefined;
}

function areaOf(v: PlcSymbol): string | undefined {
  const at = /\bAT\s+%([IQM])/i.exec(v.detail);
  return at ? ({ I: 'Inputs', Q: 'Outputs', M: 'Memory' } as Record<string, string>)[U(at[1])] : v.scope;
}

const plainType = (t?: string) => !!t && !/^(POINTER|REFERENCE)\s+TO\b|^ARRAY\b/i.test(t.trim());

/** Symbols of a PLC project from its object views (decoded .TcPOU / .TcGVL / .TcDUT). */
export function fromSource(objects: { file: string; view: string }[], members = false): AdsInterface {
  const index = new SymbolIndex();
  for (const o of objects) index.update(o.file, o.view);
  const out: AdsSymbol[] = [];
  const roots: string[] = [];
  const expand = (parent: string, type: string | undefined, path: Set<string>, depth: number) => {
    if (depth > MAX_DEPTH || !plainType(type) || path.has(U(type!))) return;
    for (const { sym, obj } of index.membersOf(type)) {
      if (!visible(sym, obj)) continue;
      const name = `${parent}.${sym.name}`;
      out.push({ name, type: sym.type ?? '', comment: commentOf(sym, obj), area: areaOf(sym) });
      expand(name, sym.type, new Set([...path, U(type!)]), depth + 1);
    }
  };
  for (const obj of index.objects()) {
    const root = obj.root;
    if (!root || (root.kind !== 'GVL' && root.kind !== 'PROGRAM')) continue;
    roots.push(root.name);
    for (const v of root.children) {
      if (!visible(v, obj)) continue;
      const name = `${root.name}.${v.name}`;
      out.push({ name, type: v.type ?? '', comment: commentOf(v, obj), area: areaOf(v) });
      if (members) expand(name, v.type, new Set(), 1);
    }
  }
  return { origin: 'source', symbols: byName(out), roots };
}

// ---- loading ----

/** The .tmc of a PLC project: <plcproj name>.tmc next to it, or the only .tmc in that folder. */
export async function findTmc(plcproj: string): Promise<string | undefined> {
  const dir = path.dirname(plcproj);
  const exact = path.join(dir, path.basename(plcproj, path.extname(plcproj)) + '.tmc');
  if (await fs.access(exact).then(() => true, () => false)) return exact;
  const all = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => /\.tmc$/i.test(f));
  return all.length === 1 ? path.join(dir, all[0]) : undefined;
}

const OBJECT_EXT = /\.(TcPOU|TcGVL|TcDUT)$/i;

/** Interface from the build output (.tmc). Throws if the project hasn't been built. */
export async function fromBuild(plc: PlcProject, members = false): Promise<AdsInterface> {
  const file = await findTmc(plc.file);
  if (!file) throw new Error(`No build output for ${plc.name}: TwinCAT writes ${plc.name}.tmc next to the .plcproj when it builds the PLC project. Build it first, or show the interface from the source code.`);
  const built = (await fs.stat(file)).mtimeMs;
  const times = await Promise.all([plc.file, ...plc.objects.map(o => o.file)].map(f => fs.stat(f).then(s => s.mtimeMs, () => 0)));
  return { origin: 'build', file, stale: times.some(t => t > built), symbols: fromTmc(await fs.readFile(file, 'utf8'), members) };
}

/** Interface from the source code in the working copy, or at a git commit when `ref` is set. */
export async function fromSourceAt(plc: PlcProject, ref: string | undefined, members = false): Promise<AdsInterface> {
  const objects: { file: string; view: string }[] = [];
  const add = (file: string, xml: string | undefined) => {
    if (!xml || isEncrypted(xml)) return;
    try { objects.push({ file, view: decode(xml.replace(/^﻿/, '')) }); } catch { /* not a PLC object we can read */ }
  };
  if (!ref) {
    for (const o of plc.objects.filter(o => OBJECT_EXT.test(o.file) && !o.encrypted)) add(o.file, await fs.readFile(o.file, 'utf8').catch(() => undefined));
  } else {
    const root = await repoRoot(plc.file);
    if (!root) throw new Error(`${plc.file} is not in a git repository`);
    for (const f of await filesAt(root, ref, plc.dir, ['.tcpou', '.tcgvl', '.tcdut'])) add(f, await show(root, ref, f));
  }
  return fromSource(objects, members);
}

// ---- comparing ----

const norm = (t: string) => U(t.replace(/\s+/g, ''));
const describe = (s: AdsSymbol) => (s.bitSize === undefined ? s.type : `${s.type} (${sizeText(s.bitSize)})`);

/** Compares two symbol lists by name (case-insensitive, like the PLC): added, removed, changed (type or size). */
export function diffSymbols(before: AdsSymbol[], after: AdsSymbol[]): AdsChange[] {
  const map = (s: AdsSymbol[]) => new Map(s.map(x => [U(x.name), x]));
  const a = map(before), b = map(after);
  const out: AdsChange[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = a.get(key), now = b.get(key);
    if (!was) { out.push({ kind: 'added', name: now!.name, after: describe(now!) }); continue; }
    if (!now) { out.push({ kind: 'removed', name: was.name, before: describe(was) }); continue; }
    const details: string[] = [];
    if (norm(was.type) !== norm(now.type)) details.push(`${was.type} → ${now.type}`);
    if (was.bitSize !== undefined && now.bitSize !== undefined && was.bitSize !== now.bitSize) details.push(`${sizeText(was.bitSize)} → ${sizeText(now.bitSize)}`);
    if (details.length) out.push({ kind: 'changed', name: now.name, before: describe(was), after: describe(now), details: details.join(', ') });
  }
  return out;
}

/**
 * Compares two interfaces. Build output against source: the build side is limited to what the source
 * can know (the project's own GVLs / programs; members only where the source could expand the type).
 */
export function diffInterfaces(before: AdsInterface, after: AdsInterface): AdsChange[] {
  if (before.origin === after.origin) return diffSymbols(before.symbols, after.symbols);
  const source = before.origin === 'source' ? before : after;
  const build = before.origin === 'source' ? after : before;
  const roots = new Set((source.roots ?? []).map(U));
  const names = new Set(source.symbols.map(s => U(s.name)));
  const parents = new Set(source.symbols.map(s => U(s.name).slice(0, U(s.name).lastIndexOf('.'))));
  const known = build.symbols.filter(s => {
    const n = U(s.name);
    if (!roots.has(n.split('.')[0])) return false;
    const parent = n.slice(0, n.lastIndexOf('.'));
    return names.has(n) || n.indexOf('.') === n.lastIndexOf('.') || parents.has(parent);
  });
  return before === build ? diffSymbols(known, source.symbols) : diffSymbols(source.symbols, known);
}

// ---- export ----

const q = (s = '') => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function symbolsToCsv(symbols: AdsSymbol[]): string {
  return ['Name;Type;BitSize;Area;Comment', ...symbols.map(s => [s.name, s.type, s.bitSize?.toString(), s.area, s.comment].map(q).join(';'))].join('\n') + '\n';
}

export function adsChangesToCsv(changes: AdsChange[]): string {
  return ['Change;Name;Before;After;Details', ...changes.map(c => [c.kind, c.name, c.before, c.after, c.details].map(q).join(';'))].join('\n') + '\n';
}

/** JSON snapshot in the CLI's format, for `iecode ads diff --against <file>`. */
export function toSnapshot(project: string, symbols: AdsSymbol[], members: boolean): string {
  return JSON.stringify({ format: SNAPSHOT_FORMAT, project, members, symbols }, null, 2) + '\n';
}
