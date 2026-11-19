// Rules that read one PLC object file (.TcPOU / .TcDUT / .TcGVL / .TcIO) as raw XML and check what TwinCAT needs to load it.
// Positions and fixes address the raw XML text, never the ST view.

import { randomUUID } from 'crypto';
import * as path from 'path';
import { CONFLICT_RE, hasXmlConflict } from '../model';
import { isEncrypted } from './projects';
import { XNode, parseXml } from '../xml';
import { Finding, Level, RuleInfo, offsetToPosition, textVersion } from './findings';

export const STRUCTURE_RULES: RuleInfo[] = [
  { id: 'xml-parse', description: 'The file is not well-formed XML', level: 'error' },
  { id: 'merge-conflict', description: 'The XML structure contains git conflict markers', level: 'error' },
  { id: 'guid-format', description: 'An Id attribute is not a GUID in braces', level: 'error' },
  { id: 'guid-unique', description: 'The same Id is used twice in one file', level: 'error' },
  { id: 'name-mismatch', description: 'The Name attribute of a method or property differs from its declaration', level: 'error' },
  { id: 'file-name-mismatch', description: 'The object name differs from the file name', level: 'warning' },
  { id: 'member-structure', description: 'A method or property lacks its declaration, implementation or accessor', level: 'error' },
  { id: 'lineids-orphan', description: 'A LineIds entry names nothing in the object', level: 'warning' },
  { id: 'naming-prefix', description: 'The object name lacks the configured prefix of its kind (needs iecode.lint.namingPrefixes)', level: 'hint' },
];

const MAIN_ELEMENTS = new Set(['POU', 'DUT', 'GVL', 'Itf']);
const MEMBER_ELEMENTS = new Set(['Method', 'Property', 'Action', 'Transition']);
const GUID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

const child = (n: XNode, name: string) => n.children.find(c => c.name === name);

/** The value range of an attribute inside the opening tag of a node (or the node's tag when absent). */
function attrRange(src: string, node: XNode, name: string): { start: number; end: number } {
  const tag = src.slice(node.start, node.innerStart);
  const m = new RegExp(`(?<=\\s)${name}\\s*=\\s*"`).exec(tag);
  if (!m) return { start: node.start, end: Math.min(node.innerStart, node.start + 1 + node.name.length) };
  const start = node.start + m.index + m[0].length;
  return { start, end: start + (tag.slice(m.index + m[0].length).indexOf('"')) };
}

/** Text of a declaration: its CDATA sections, or the raw element text when it has none. */
function declText(src: string, decl: XNode | undefined): string | undefined {
  if (!decl) return undefined;
  return decl.cdata?.length ? decl.cdata.map(c => c.text).join('') : src.slice(decl.innerStart, decl.innerEnd);
}

/** Declaration text without comments and pragmas, so the first keyword token is the one the compiler reads. */
function stripNoise(text: string): string {
  return text.replace(/\(\*[\s\S]*?\*\)/g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\{[^}]*\}/g, ' ');
}

const MODIFIERS = '(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL|ABSTRACT|OVERRIDE)';

/** The member name after METHOD / PROPERTY and its access modifiers. */
function declaredName(decl: string): string | undefined {
  return new RegExp(`^\\s*(?:METHOD|PROPERTY)\\b(?:\\s+${MODIFIERS}\\b)*\\s+([A-Za-z_]\\w*)`, 'i').exec(stripNoise(decl))?.[1];
}

/** Kind of an object from its first declaration keyword, for the naming prefixes. */
function kindOfDeclaration(decl: string): string | undefined {
  const t = stripNoise(decl);
  const m = /^\s*(FUNCTION_BLOCK|PROGRAM|FUNCTION|INTERFACE|VAR_GLOBAL|TYPE)\b/i.exec(t);
  if (!m) return undefined;
  const k = m[1].toUpperCase();
  if (k === 'VAR_GLOBAL') return 'GVL';
  if (k !== 'TYPE') return k;
  if (/\bSTRUCT\b/i.test(t)) return 'STRUCT';
  if (/\bUNION\b/i.test(t)) return 'UNION';
  return /^\s*TYPE\s+\w+\s*:\s*\(/i.test(t) ? 'ENUM' : 'ALIAS';
}

/** Names that a LineIds entry may carry: the object, its members and the accessors of its properties. */
function lineIdNames(main: XNode): Set<string> {
  const names = new Set<string>([main.attrs.Name]);
  for (const c of main.children) {
    if (!MEMBER_ELEMENTS.has(c.name)) continue;
    const n = `${main.attrs.Name}.${c.attrs.Name}`;
    names.add(n);
    if (c.name === 'Property') for (const a of c.children) if (a.name === 'Get' || a.name === 'Set') names.add(`${n}.${a.name}`);
  }
  return names;
}

function* walkNodes(n: XNode): Generator<XNode> {
  yield n;
  for (const c of n.children) yield* walkNodes(c);
}

export function checkStructure(xml: string, file: string, opts: { namingPrefixes?: Record<string, string> } = {}): Finding[] {
  const out: Finding[] = [];
  const version = textVersion(xml);
  const add = (rule: string, level: Level, message: string, start: number, end: number, fix?: Finding['fix']) => {
    const a = offsetToPosition(xml, start), b = offsetToPosition(xml, end);
    out.push({ rule, level, message, file, space: 'xml', version, line: a.line, col: a.col, endLine: b.line, endCol: b.col, ...(fix ? { fix } : {}) });
  };
  const level = (id: string) => STRUCTURE_RULES.find(r => r.id === id)!.level as Level;

  if (isEncrypted(xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml)) return out;   // a protected object is binary: nothing to check

  if (hasXmlConflict(xml)) {
    const at = new RegExp(CONFLICT_RE.source, 'm').exec(xml)?.index ?? 0;
    add('merge-conflict', level('merge-conflict'), 'The XML structure has unresolved merge conflict markers', at, at + 7);
    return out;
  }
  let root: XNode;
  try { root = parseXml(xml); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const at = Number(/ at (\d+)/.exec(msg)?.[1] ?? 0);
    add('xml-parse', level('xml-parse'), `The file is not well-formed XML: ${msg}`, at, at + 1);
    return out;
  }
  const main = child(root, 'TcPlcObject')?.children.find(c => MAIN_ELEMENTS.has(c.name));
  if (!main) return out;                                   // a project information file or another kind of file: nothing to check
  const isItf = main.name === 'Itf';

  // Ids: format, then uniqueness (the later duplicate gets the fix)
  const seen = new Set<string>();
  for (const n of walkNodes(main)) {
    const id = n.attrs.Id;
    if (id === undefined || n.name === 'LineId' || n.name === 'LineIds') continue;   // a LineId's Id is a line number
    const r = attrRange(xml, n, 'Id');
    if (!GUID_RE.test(id)) add('guid-format', level('guid-format'), `Id "${id}" of ${n.name}${n.attrs.Name ? ' ' + n.attrs.Name : ''} is not a GUID in braces`, r.start, r.end);
    else if (seen.has(id.toLowerCase())) {
      add('guid-unique', level('guid-unique'), `Id ${id} is used more than once in this file`, r.start, r.end,
        { title: 'Generate a new Id for the later duplicate (changes the identity of this member)', edit: { start: r.start, end: r.end, text: `{${randomUUID()}}` } });
    } else seen.add(id.toLowerCase());
  }

  const mainDecl = declText(xml, child(main, 'Declaration'));
  const base = path.basename(file).replace(/\.[^.]*$/, '');
  if (main.attrs.Name !== undefined && main.attrs.Name.toLowerCase() !== base.toLowerCase()) {
    const r = attrRange(xml, main, 'Name');
    add('file-name-mismatch', level('file-name-mismatch'), `Object name "${main.attrs.Name}" differs from the file name "${base}"`, r.start, r.end);
  }
  if (opts.namingPrefixes && main.attrs.Name !== undefined && mainDecl !== undefined) {
    const kind = isItf ? 'INTERFACE' : kindOfDeclaration(mainDecl);
    const prefix = kind && opts.namingPrefixes[kind];
    if (prefix && !main.attrs.Name.startsWith(prefix)) {
      const r = attrRange(xml, main, 'Name');
      add('naming-prefix', level('naming-prefix'), `${kind} names should start with "${prefix}"`, r.start, r.end);
    }
  }

  for (const m of main.children) {
    if (m.name !== 'Method' && m.name !== 'Property') continue;
    const decl = child(m, 'Declaration');
    const text = declText(xml, decl);
    const nameAt = attrRange(xml, m, 'Name');
    if (m.name === 'Method') {
      if (!decl) add('member-structure', level('member-structure'), `Method ${m.attrs.Name} has no Declaration`, nameAt.start, nameAt.end);
      else if (!isItf && !child(m, 'Implementation') && !/\bABSTRACT\b/i.test(stripNoise(text ?? '')))
        add('member-structure', level('member-structure'), `Method ${m.attrs.Name} has no Implementation`, nameAt.start, nameAt.end);
    } else if (!isItf && !m.children.some(c => c.name === 'Get' || c.name === 'Set')) {
      add('member-structure', level('member-structure'), `Property ${m.attrs.Name} has neither Get nor Set`, nameAt.start, nameAt.end);
    }
    const declared = text === undefined ? undefined : declaredName(text);
    if (declared && m.attrs.Name !== undefined && declared.toLowerCase() !== m.attrs.Name.toLowerCase())
      add('name-mismatch', level('name-mismatch'), `Name "${m.attrs.Name}" differs from the declaration "${declared}"`, nameAt.start, nameAt.end);
  }

  // LineIds
  const valid = lineIdNames(main);
  for (const li of main.children) {
    if (li.name !== 'LineIds' || valid.has(li.attrs.Name)) continue;
    const r = attrRange(xml, li, 'Name');
    // the whole line(s) of the node, so no blank line stays behind
    let start = li.start;
    while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) start--;
    let end = li.end;
    if (xml.startsWith('\r\n', end)) end += 2; else if (xml[end] === '\n') end += 1;
    add('lineids-orphan', level('lineids-orphan'), `LineIds "${li.attrs.Name}" names no object, member or accessor`, r.start, r.end,
      { title: 'Remove the LineIds entry (TwinCAT creates it again)', edit: { start, end, text: '' } });
  }
  return out;
}
