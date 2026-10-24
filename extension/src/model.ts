// Projection between a TwinCAT PLC object file (.TcPOU/.TcDUT/.TcGVL/.TcIO)
// and a single plain-text Structured Text view.
//
//   decode(xml)        -> ST text shown in the editor
//   encode(xml, text)  -> new xml: only CDATA payloads of changed sections are
//                         spliced; added/removed sections insert/remove elements.
//
// View format:
//   <main declaration>
//   //---- IMPLEMENTATION ----
//   <main implementation>
//   //==== METHOD Start ====
//   <declaration>
//   //---- IMPLEMENTATION ----
//   <implementation>
//   //==== PROPERTY Speed ====   (declaration only)
//   //==== GET Speed ====        (accessor of property Speed)
//   //==== ACTION Reset ====     (implementation only)

import { randomUUID } from 'crypto';
import { XNode, parseXml, cdataText, toCdata, child, escapeAttr } from './xml';

export type Kind = 'MAIN' | 'METHOD' | 'PROPERTY' | 'GET' | 'SET' | 'ACTION' | 'TRANSITION';

const ELEMENT: Record<Exclude<Kind, 'MAIN'>, string> = {
  METHOD: 'Method', PROPERTY: 'Property', GET: 'Get', SET: 'Set', ACTION: 'Action', TRANSITION: 'Transition',
};
const KIND_OF: Record<string, Kind> = Object.fromEntries(Object.entries(ELEMENT).map(([k, v]) => [v, k as Kind]));
const MAIN_ELEMENTS = ['POU', 'DUT', 'GVL', 'Itf'];

export const HEADER_RE = /^\/\/==== (METHOD|PROPERTY|GET|SET|ACTION|TRANSITION) ([A-Za-z_]\w*) ====\s*$/;
export const IMPL_RE = /^\/\/---- IMPLEMENTATION(?: \((.*)\))? ----\s*$/;
const IMPL_MARKER = '//---- IMPLEMENTATION ----';

interface XmlSection {
  kind: Kind;
  name: string;
  key: string;
  node: XNode;
  decl?: XNode;           // <Declaration>
  impl?: XNode;           // <Implementation>
  st?: XNode;             // <Implementation><ST>
  lineIdsName: string;    // Name of matching <LineIds> entry
}

interface TextSection {
  kind: Kind;
  name: string;
  key: string;
  decl: string | null;    // null = no declaration lines present
  impl: string | null;    // null = no implementation marker present
  line: number;           // header line (0-based) for error messages
}

export class ViewError extends Error {
  constructor(msg: string, public line?: number) { super(line !== undefined ? `Line ${line + 1}: ${msg}` : msg); }
}

const keyOf = (kind: Kind, name: string) => `${kind}:${name}`;
const nl = (s: string) => s.replace(/\r\n/g, '\n');

function detectEol(xml: string) { return xml.includes('\r\n') ? '\r\n' : '\n'; }

function findMain(root: XNode): XNode {
  const obj = child(root, 'TcPlcObject');
  const main = obj?.children.find(c => MAIN_ELEMENTS.includes(c.name));
  if (!main) throw new ViewError('Not a TwinCAT PLC object (expected POU, DUT, GVL or Itf)');
  return main;
}

function collect(main: XNode): XmlSection[] {
  const out: XmlSection[] = [];
  const add = (kind: Kind, name: string, key: string, node: XNode, lineIdsName: string) => {
    const impl = child(node, 'Implementation');
    out.push({ kind, name, key, node, decl: child(node, 'Declaration'), impl, st: impl && child(impl, 'ST'), lineIdsName });
  };
  const mainName = main.attrs.Name;
  add('MAIN', mainName, 'MAIN', main, mainName);
  for (const c of main.children) {
    const kind = KIND_OF[c.name];
    if (!kind || kind === 'GET' || kind === 'SET') continue;
    add(kind, c.attrs.Name, keyOf(kind, c.attrs.Name), c, `${mainName}.${c.attrs.Name}`);
    if (kind === 'PROPERTY') {
      for (const acc of c.children) {
        const ak = KIND_OF[acc.name];
        if (ak === 'GET' || ak === 'SET')
          add(ak, c.attrs.Name, keyOf(ak, c.attrs.Name), acc, `${mainName}.${c.attrs.Name}.${acc.name}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- decode

export function decode(xml: string): string {
  const main = findMain(parseXml(xml));
  const parts: string[] = [];
  for (const s of collect(main)) {
    const lines: string[] = [];
    if (s.kind !== 'MAIN') lines.push(`//==== ${s.kind} ${s.name} ====`);
    if (s.decl) lines.push(nl(cdataText(s.decl) ?? ''));
    if (s.impl) {
      if (s.st) lines.push(IMPL_MARKER, nl(cdataText(s.st) ?? ''));
      else {
        const lang = s.impl.children[0]?.name ?? 'unknown';
        lines.push(`//---- IMPLEMENTATION (${lang}, read-only - edit in TwinCAT) ----`);
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------- parse view

export function parseView(text: string): TextSection[] {
  const lines = nl(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const heads: { kind: Kind; name: string; line: number }[] = [{ kind: 'MAIN', name: '', line: -1 }];
  lines.forEach((l, i) => {
    const m = HEADER_RE.exec(l);
    if (m) heads.push({ kind: m[1] as Kind, name: m[2], line: i });
  });

  const out: TextSection[] = [];
  const seen = new Set<string>();
  heads.forEach((h, idx) => {
    const from = h.line + 1;
    const to = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
    const body = lines.slice(from, to);
    const m = body.findIndex(l => IMPL_RE.test(l));
    const key = h.kind === 'MAIN' ? 'MAIN' : keyOf(h.kind, h.name);
    if (seen.has(key)) throw new ViewError(`Duplicate section ${h.kind} ${h.name}`, h.line);
    seen.add(key);
    const declLines = m < 0 ? body : body.slice(0, m);
    out.push({
      kind: h.kind, name: h.name, key, line: Math.max(h.line, 0),
      decl: declLines.length ? declLines.join('\n') : null,
      impl: m < 0 ? null : body.slice(m + 1).join('\n'),
    });
  });
  return out;
}

// ---------------------------------------------------------------- encode

interface Edit { start: number; end: number; text: string }

export function encode(xml: string, view: string): string {
  const eol = detectEol(xml);
  const toFile = (s: string) => s.replace(/\n/g, eol);
  const main = findMain(parseXml(xml));
  const existing = new Map(collect(main).map(s => [s.key, s]));
  const wanted = parseView(view);
  const wantedKeys = new Set(wanted.map(s => s.key));
  const edits: Edit[] = [];
  const removed = new Set<XNode>();

  const lineStart = (pos: number) => xml.lastIndexOf('\n', pos - 1) + 1;
  const removeNode = (n: XNode) => {
    let end = n.end;
    if (xml.startsWith(eol, end)) end += eol.length;
    edits.push({ start: lineStart(n.start), end, text: '' });
    removed.add(n);
  };
  const lineIds = (name: string) => main.children.find(c => c.name === 'LineIds' && c.attrs.Name === name);
  const isInsideRemoved = (n: XNode) => { for (let p = n.parent; p; p = p.parent) if (removed.has(p)) return true; return false; };

  // indentation of main's children, and one indent unit
  const indentOf = (n: XNode) => xml.slice(lineStart(n.start), n.start);
  const firstChild = main.children[0];
  const childIndent = firstChild ? indentOf(firstChild) : indentOf(main) + '  ';
  const unit = childIndent.slice(indentOf(main).length) || '  ';

  // 1. changed / validated sections that already exist
  for (const t of wanted) {
    const x = existing.get(t.key);
    if (!x) continue;
    if (x.decl) {
      const newDecl = t.decl ?? '';
      if (newDecl !== nl(cdataText(x.decl) ?? ''))
        edits.push({ start: x.decl.innerStart, end: x.decl.innerEnd, text: toCdata(toFile(newDecl)) });
    } else if (t.decl !== null && t.decl.trim() !== '') {
      throw new ViewError(`${t.kind} ${t.name} cannot have a declaration`, t.line);
    }
    if (t.impl !== null) {
      if (!x.impl) throw new ViewError(`${t.kind} ${t.name} has no implementation in this object type`, t.line);
      if (x.st && t.impl !== nl(cdataText(x.st) ?? '')) {
        edits.push({ start: x.st.innerStart, end: x.st.innerEnd, text: toCdata(toFile(t.impl)) });
        // stale line mapping; TwinCAT regenerates it on next save/compile
        const li = lineIds(x.lineIdsName);
        if (li) removeNode(li);
      }
    }
  }
  if (!wantedKeys.has('MAIN')) throw new ViewError('Main declaration missing');

  // 2. removed sections
  for (const x of existing.values()) {
    if (x.kind === 'MAIN' || wantedKeys.has(x.key)) continue;
    // collect() yields a PROPERTY before its accessors, so accessors of a removed property are skipped here
    if (!isInsideRemoved(x.node)) removeNode(x.node);
    const li = lineIds(x.lineIdsName);
    if (li && !removed.has(li)) removeNode(li);
  }

  // 3. added sections
  const byKey = new Map(wanted.map(t => [t.key, t]));
  const build = (t: TextSection, ind: string): string => {
    const el = ELEMENT[t.kind as Exclude<Kind, 'MAIN'>];
    const name = t.kind === 'GET' || t.kind === 'SET' ? el : t.name;
    const L: string[] = [`${ind}<${el} Name="${escapeAttr(name)}" Id="{${randomUUID()}}">`];
    const hasDecl = t.kind !== 'ACTION' && t.kind !== 'TRANSITION';
    if (hasDecl) L.push(`${ind}${unit}<Declaration>${toCdata(toFile(t.decl ?? ''))}</Declaration>`);
    else if (t.decl && t.decl.trim()) throw new ViewError(`${t.kind} ${t.name} cannot have a declaration`, t.line);
    if (t.kind === 'PROPERTY') {
      if (t.impl !== null) throw new ViewError('A PROPERTY has no implementation; use GET/SET sections', t.line);
      for (const acc of ['GET', 'SET'] as const) {
        const a = byKey.get(keyOf(acc, t.name));
        if (a) L.push(build(a, ind + unit));
      }
    } else if (t.impl !== null || !hasDecl) {
      L.push(`${ind}${unit}<Implementation>`, `${ind}${unit}${unit}<ST>${toCdata(toFile(t.impl ?? ''))}</ST>`, `${ind}${unit}</Implementation>`);
    }
    L.push(`${ind}</${el}>`);
    return L.join(eol);
  };

  const anchor = main.children.find(c => c.name === 'LineIds');
  const topPos = lineStart(anchor ? anchor.start : main.innerEnd);
  const topInserts: string[] = [];
  for (const t of wanted) {
    if (existing.has(t.key)) continue;
    if (t.kind === 'GET' || t.kind === 'SET') {
      const prop = existing.get(keyOf('PROPERTY', t.name));
      if (prop) {
        edits.push({ start: lineStart(prop.node.innerEnd), end: lineStart(prop.node.innerEnd), text: build(t, childIndent + unit) + eol });
      } else if (!byKey.has(keyOf('PROPERTY', t.name))) {
        throw new ViewError(`${t.kind} ${t.name} needs a PROPERTY ${t.name} section`, t.line);
      }
      continue;
    }
    topInserts.push(build(t, childIndent) + eol);
  }
  if (topInserts.length) edits.push({ start: topPos, end: topPos, text: topInserts.join('') });

  // apply back-to-front; drop edits inside removed ranges
  const removals = edits.filter(e => e.text === '' && e.end > e.start);
  const effective = edits.filter(e => !removals.some(r => r !== e && e.start >= r.start && e.end <= r.end && !(e.start === r.start && e.end === r.end)));
  effective.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = xml;
  for (const e of effective) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Outline helper for the editor: section headers with line numbers. */
export function outline(text: string) {
  return nl(text).split('\n').flatMap((l, i) => {
    const m = HEADER_RE.exec(l);
    return m ? [{ kind: m[1] as Kind, name: m[2], line: i }] : [];
  });
}
