// Object graph: which PLC object or member references which. Task 1 extracts the edges of one file;
// graph assembly, implicit edges and reachability follow in the same module.

import { ELEMENTARY_TYPES, KEYWORDS, tokenize } from '../lang/lexer';
import { IndexedObject, SymbolIndex } from '../lang/index';
import { PlcSymbol, SymbolKind } from '../lang/parser';

/** Upper-cased for lookup: object `FB_X`, member `FB_X.START`; a library object gets the library as prefix: `LIB::FB_X`. */
export type NodeId = string;

export interface GraphNode { id: NodeId; name: string; kind: SymbolKind; file: string; line: number; library: boolean; owner?: NodeId }

export type EdgeReason = 'call' | 'type' | 'extends' | 'implements' | 'non-st';

export interface FileEdges {
  nodes: GraphNode[];
  refs: { from: NodeId; to: NodeId; line: number; reason: EdgeReason }[];
  /** An identifier that resolves to nothing: treated as a reference to every member of that name (reason `by-name`). */
  unresolved: { from: NodeId; name: string; line: number }[];
  /** Words of non-ST bodies (raw XML), attributed to their own section node. */
  words: { from: NodeId; word: string }[];
}

const U = (s: string) => s.toUpperCase();
const MEMBER_KINDS = new Set<string>(['METHOD', 'PROPERTY', 'ACTION', 'TRANSITION']);
const ROOT_KINDS = new Set<string>(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'STRUCT', 'UNION', 'ENUM', 'ALIAS', 'GVL']);
/** Operators and standard functions the compiler provides; never worth a by-name reference. */
const BUILTIN = /^(__\w+|ADR|BITADR|SIZEOF|ABS|SEL|MAX|MIN|LIMIT|MUX|SQRT|EXPT|LN|LOG|EXP|SIN|COS|TAN|ASIN|ACOS|ATAN|TRUNC|ROL|ROR|SHL|SHR|LEN|LEFT|RIGHT|MID|CONCAT|INSERT|DELETE|REPLACE|FIND|\w+_TO_\w+|TO_\w+|TRUE|FALSE|THIS|SUPER|NULL)$/;

export const objectId = (o: IndexedObject): NodeId =>
  (o.library ? `${U(o.library)}::` : '') + U(o.root?.name ?? o.file.split(/[\\/]/).pop()!.replace(/\.\w+$/, ''));
export const memberId = (o: IndexedObject, name: string): NodeId => `${objectId(o)}.${U(name)}`;

/** Edges of one object: references from its members (or from the object itself for its declaration part and its main body). */
export function fileEdges(index: SymbolIndex, obj: IndexedObject, nonSt?: Map<string, string>): FileEdges {
  const out: FileEdges = { nodes: [], refs: [], unresolved: [], words: [] };
  const root = obj.root;
  if (!root) return out;
  const self = objectId(obj);
  out.nodes.push({ id: self, name: root.name, kind: root.kind, file: obj.file, line: root.range.line, library: !!obj.library });
  const members = root.children.filter(c => MEMBER_KINDS.has(c.kind));
  for (const m of members)
    out.nodes.push({ id: memberId(obj, m.name), name: m.name, kind: m.kind, file: obj.file, line: m.range.line, library: !!obj.library, owner: self });

  const fromOfLine = (line: number): NodeId => {
    const m = members.find(c => line >= c.full.line && line <= c.full.endLine);
    return m ? memberId(obj, m.name) : self;
  };

  // names that declare something (object, members, variables, locals): not references
  const declared = new Set<string>();
  const markDeclared = (s: PlcSymbol) => { declared.add(`${s.range.line}:${s.range.col}`); s.children.forEach(markDeclared); };
  markDeclared(root);

  // EXTENDS / IMPLEMENTS: edges from the object; tokens on the header line then give no second edge
  const seen = new Set<string>();
  const add = (from: NodeId, to: NodeId, line: number, reason: EdgeReason) => {
    const k = `${from}>${to}@${line}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.refs.push({ from, to, line, reason });
  };
  const headerReason = new Map<string, EdgeReason>();
  for (const n of root.extends ?? []) headerReason.set(U(n), 'extends');
  for (const n of root.implements ?? []) headerReason.set(U(n), 'implements');
  for (const [name, reason] of headerReason) {
    const target = index.find(name);
    if (target?.root) add(self, objectId(target), root.range.line, reason);
  }

  const toks = tokenize(obj.view);
  let paren = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === '(') paren++;
    else if (t.text === ')') paren = Math.max(0, paren - 1);
    if (t.type !== 'ident') continue;
    if (declared.has(`${t.line}:${t.col}`)) continue;
    if (KEYWORDS.has(t.upper) || ELEMENTARY_TYPES.has(t.upper)) continue;
    const next = toks[i + 1];
    if (paren > 0 && (next?.text === ':=' || next?.text === '=>')) continue;        // formal parameter name of a call
    if (next?.text === '.' && index.namespace(t.text) && !index.find(t.text)) continue;   // Tc2_Standard.TON: the namespace only selects the library
    const from = fromOfLine(t.line);
    const loc = index.resolveAt(obj, t.line, t.offset);
    if (!loc) {
      if (!BUILTIN.test(t.upper)) out.unresolved.push({ from, name: t.text, line: t.line });
      continue;
    }
    const owner = index.get(loc.file);
    if (!owner?.root) continue;
    const kind = loc.symbol.kind;
    let to: NodeId;
    let reason: EdgeReason;
    if (ROOT_KINDS.has(kind) && loc.symbol === owner.root) { to = objectId(owner); reason = 'type'; }
    else if (MEMBER_KINDS.has(kind) && owner.root.children.includes(loc.symbol)) { to = memberId(owner, loc.symbol.name); reason = 'call'; }
    else if (owner === obj) continue;                                                // own variable or local: no edge
    else { to = objectId(owner); reason = 'type'; }                                  // variable, field or enum value: its owning object
    if (t.line === root.range.line && headerReason.has(t.upper)) reason = headerReason.get(t.upper)!;
    if (to === from || (to === self && from === self)) continue;
    add(from, to, t.line, reason);
  }

  // non-ST bodies: every word of the raw XML, attributed to the section it belongs to
  for (const [key, raw] of nonSt ?? []) {
    const [kind, name] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
    const from = kind === 'MAIN' ? self : memberId(obj, name);
    const words = new Set(raw.match(/[A-Za-z_]\w*/g) ?? []);
    for (const word of words) out.words.push({ from, word });
  }
  return out;
}
