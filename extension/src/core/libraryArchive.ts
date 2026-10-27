// Reads the sources of a (non-compiled) TwinCAT .library file without TwinCAT.
//
// A .library is a ZIP written by CODESYS:
//   __shared_data_storage_string_table__.auxiliary   all strings: varint count, then (varint index, varint length, UTF-8)*
//   <guid>.meta     object header: guid, parent guid (methods, properties …), name, folder guid
//   <guid>.object   object content; each text line is a record 0x0b <int64 line id> <flag> <varint string index>.
//                   A POU holds two runs of line records: implementation, then declaration.
// Object kinds are taken from the declaration text, so the binary type GUIDs are not needed. Each top-level
// POU / DUT / GVL / interface becomes TwinCAT object XML (.TcPOU …), which the regular ST view can decode.

import { zipEntries, zipRead } from './zip';
import { LibraryId, ObjectType, parseLibraryId } from './projects';
import { escapeAttr, toCdata } from '../xml';

export interface LibraryObject {
  name: string;
  /** Folder inside the library, '/' separated ('' at the top). */
  folder: string;
  ext: '.TcPOU' | '.TcDUT' | '.TcGVL' | '.TcIO';
  type: ObjectType;
  /** TwinCAT object XML, as it would be exported to a .TcPOU / .TcDUT / … file. */
  xml: string;
}

export interface LibraryArchive {
  objects: LibraryObject[];
  /** Libraries this library references (from its library manager). */
  dependencies: LibraryId[];
}

const NULL_GUID = '00000000-0000-0000-0000-000000000000';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER = 20;                       // 16 byte signature + uint32 length

function varint(b: Buffer, p: number): [number, number] {
  let r = 0, s = 0;
  for (;;) {
    if (p >= b.length) throw new RangeError('varint past end');
    const c = b[p++];
    r += (c & 0x7f) * 2 ** s;
    s += 7;
    if (c < 0x80) return [r, p];
  }
}

export function stringTable(b: Buffer): string[] {
  const out: string[] = [];
  let [n, p] = varint(b, 0);
  while (n-- > 0 && p < b.length) {
    let idx: number, len: number;
    [idx, p] = varint(b, p);
    [len, p] = varint(b, p);
    out[idx] = b.toString('utf8', p, p + len);
    p += len;
  }
  return out;
}

interface Meta { guid: string; parent: string; name: string; folder?: string }

function readMeta(b: Buffer, s: string[]): Meta | undefined {
  if (b.length < HEADER + 4 || b[HEADER] !== 0x0f) return undefined;
  let p = HEADER + 2, g: number, par: number, nm: number;
  [g, p] = varint(b, p);
  [par, p] = varint(b, p);
  [nm, p] = varint(b, p);
  const meta: Meta = { guid: s[g], parent: s[par], name: s[nm] };
  // the folder guid follows the (fixed) property block 80 0c 80 0c 5f
  const at = b.indexOf(Buffer.from([0x80, 0x0c, 0x80, 0x0c, 0x5f]), p);
  if (at > 0) meta.folder = s[varint(b, at + 5)[0]];
  return meta.guid && meta.name !== undefined ? meta : undefined;
}

/** The text documents of an object (runs of consecutive line records), in file order. */
export function textRuns(b: Buffer, s: string[]): string[][] {
  const runs: string[][] = [];
  let cur: string[] = [], last = -1;
  for (let i = HEADER; i + 10 < b.length;) {
    if (b[i] === 0x0b && b[i + 5] === 0 && b[i + 6] === 0 && b[i + 7] === 0 && b[i + 8] === 0 && b[i + 9] === 0) {
      const [idx, next] = varint(b, i + 10);
      // a GUID is an object reference whose bytes happen to look like a line record (and may overlap a real one)
      if (s[idx] !== undefined && !GUID_RE.test(s[idx])) {
        if (i !== last && cur.length) { runs.push(cur); cur = []; }
        cur.push(s[idx]);
        last = i = next;
        continue;
      }
    }
    i++;
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** First keyword of a declaration, skipping comments and pragmas. */
const firstKeyword = (text: string) =>
  /^\s*([A-Za-z_]+)/.exec(text.replace(/\(\*[\s\S]*?\*\)|\/\/.*$|\{[^}]*\}/gm, ' '))?.[1].toUpperCase();

const DECL_KEYWORDS = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'TYPE', 'VAR_GLOBAL', 'METHOD', 'PROPERTY',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_INST', 'VAR_STAT', 'VAR_TEMP']);

interface Text { decl?: string; impl?: string }

function texts(runs: string[][]): Text {
  const join = (r?: string[]) => r?.join('\n');
  if (runs.length >= 2) return { impl: join(runs[runs.length - 2]), decl: join(runs[runs.length - 1]) };
  if (runs.length === 1) {
    const t = join(runs[0])!;
    return DECL_KEYWORDS.has(firstKeyword(t) ?? '') ? { decl: t } : { impl: t };
  }
  return {};
}

const MAIN: Record<string, { el: string; ext: LibraryObject['ext'] }> = {
  FUNCTION_BLOCK: { el: 'POU', ext: '.TcPOU' }, PROGRAM: { el: 'POU', ext: '.TcPOU' }, FUNCTION: { el: 'POU', ext: '.TcPOU' },
  INTERFACE: { el: 'Itf', ext: '.TcIO' }, TYPE: { el: 'DUT', ext: '.TcDUT' }, VAR_GLOBAL: { el: 'GVL', ext: '.TcGVL' },
};

function objectType(kw: string, decl: string): ObjectType {
  if (kw === 'TYPE') {
    const code = decl.replace(/\(\*[\s\S]*?\*\)|\/\/.*$|\{[^}]*\}/gm, ' ');
    return /\bSTRUCT\b/i.test(code) ? 'STRUCT' : /\bUNION\b/i.test(code) ? 'UNION' : /:\s*\(/.test(code) ? 'ENUM' : 'ALIAS';
  }
  return kw === 'VAR_GLOBAL' ? 'GVL' : kw as ObjectType;
}

export function readLibraryArchive(buf: Buffer): LibraryArchive {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map(e => [e.name.toLowerCase(), e]));
  const st = byName.get('__shared_data_storage_string_table__.auxiliary');
  if (!st) throw new Error('No string table: not a TwinCAT/CODESYS library');
  const s = stringTable(zipRead(buf, st));

  const metas = new Map<string, Meta & { text: Text }>();
  for (const e of entries) {
    if (!/\.meta$/i.test(e.name)) continue;
    const obj = byName.get(e.name.slice(0, -5).toLowerCase() + '.object');
    try {
      const m = readMeta(zipRead(buf, e), s);
      if (!m || !obj) continue;
      metas.set(m.guid, { ...m, text: texts(textRuns(zipRead(buf, obj), s)) });
    } catch { /* an object we can't read: skip it */ }
  }

  const children = new Map<string, (Meta & { text: Text })[]>();
  for (const m of metas.values())
    if (m.parent && m.parent !== NULL_GUID && metas.has(m.parent)) {
      const l = children.get(m.parent) ?? [];
      l.push(m);
      children.set(m.parent, l);
    }

  const folderOf = (m: Meta) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let f = m.folder && metas.get(m.folder); f && !seen.has(f.guid); f = f.folder ? metas.get(f.folder) : undefined) {
      seen.add(f.guid);
      parts.unshift(f.name);
    }
    return parts.join('/');
  };

  const objects: LibraryObject[] = [];
  for (const m of metas.values()) {
    if (m.parent && m.parent !== NULL_GUID) continue;
    const kw = m.text.decl !== undefined ? firstKeyword(m.text.decl) : undefined;
    const main = kw && MAIN[kw];
    if (!main) continue;
    objects.push({ name: m.name, folder: folderOf(m), ext: main.ext, type: objectType(kw!, m.text.decl!), xml: toXml(main.el, m, children) });
  }
  objects.sort((a, b) => (a.folder + '/' + a.name).localeCompare(b.folder + '/' + b.name));

  const dependencies: LibraryId[] = [];
  for (const str of s) {
    const id = str && str.length < 200 ? parseLibraryId(str) : undefined;
    if (id && /^(\*|\d+(\.\d+){1,3})$/.test(id.version) && /^[A-Za-z_][\w.]*$/.test(id.name) && !dependencies.some(d => d.name.toLowerCase() === id.name.toLowerCase())) dependencies.push(id);
  }
  return { objects, dependencies };
}

function toXml(el: string, m: Meta & { text: Text }, children: Map<string, (Meta & { text: Text })[]>): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject Version="1.1.0.1">'];
  const attrs = (x: Meta) => `Name="${escapeAttr(x.name)}" Id="{${x.guid}}"`;
  const body = (t: Text, ind: string, withImpl: boolean) => {
    out.push(`${ind}<Declaration>${toCdata(t.decl ?? '')}</Declaration>`);
    if (withImpl) out.push(`${ind}<Implementation>`, `${ind}  <ST>${toCdata(t.impl ?? '')}</ST>`, `${ind}</Implementation>`);
  };
  const isItf = el === 'Itf';
  out.push(`  <${el} ${attrs(m)}>`);
  body(m.text, '    ', el === 'POU');
  const kids = [...(children.get(m.guid) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of kids) {
    const kw = c.text.decl !== undefined ? firstKeyword(c.text.decl) : undefined;
    if (kw === 'METHOD') {
      out.push(`    <Method ${attrs(c)}>`);
      body(c.text, '      ', !isItf);
      out.push('    </Method>');
    } else if (kw === 'PROPERTY') {
      out.push(`    <Property ${attrs(c)}>`);
      out.push(`      <Declaration>${toCdata(c.text.decl ?? '')}</Declaration>`);
      for (const acc of (children.get(c.guid) ?? []).filter(a => /^(Get|Set)$/i.test(a.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const tag = /^get$/i.test(acc.name) ? 'Get' : 'Set';
        out.push(`      <${tag} Name="${tag}" Id="{${acc.guid}}">`);
        body(acc.text, '        ', !isItf);
        out.push(`      </${tag}>`);
      }
      out.push('    </Property>');
    } else if (!isItf && c.text.impl !== undefined && c.text.decl === undefined) {
      out.push(`    <Action ${attrs(c)}>`, '      <Implementation>', `        <ST>${toCdata(c.text.impl)}</ST>`, '      </Implementation>', '    </Action>');
    }
  }
  out.push(`  </${el}>`, '</TcPlcObject>');
  return out.join('\r\n');
}
