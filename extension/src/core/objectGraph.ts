// Object graph: which PLC object or member references which. Task 1 extracts the edges of one file;
// graph assembly, implicit edges and reachability follow in the same module.

import { ELEMENTARY_TYPES, KEYWORDS, tokenize } from '../lang/lexer';
import { IndexedObject, SymbolIndex } from '../lang/index';
import { PlcSymbol, SymbolKind } from '../lang/parser';
import { classChain, interfaceClosure } from '../lang/inheritance';

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

// ---------------------------------------------------------------- graph, implicit edges, reachability

export interface Edge { from: NodeId; to: NodeId; line: number; reason: EdgeReason }

/** A member that becomes reachable when `key` and its owner object are both reachable. */
interface Implicit { member: NodeId; owner: NodeId; reason: 'interface' | 'override' }

export interface ObjectGraph {
  nodes: Map<NodeId, GraphNode>;
  out: Map<NodeId, Edge[]>;
  in: Map<NodeId, Edge[]>;
  /** Unresolved name (upper case) to the nodes that mention it. */
  byNameUnresolved: Map<string, NodeId[]>;
  /** Interface member or overridden base member to the members that implement or override it (with their owner). */
  implicit: Map<NodeId, Implicit[]>;
  /** Members that implement an interface member, override a base member, or belong to an interface (never reported). */
  contract: Set<NodeId>;
}

const INIT_METHODS = new Set(['FB_INIT', 'FB_EXIT', 'FB_REINIT']);

export function assemble(files: FileEdges[], index: SymbolIndex): ObjectGraph {
  const g: ObjectGraph = { nodes: new Map(), out: new Map(), in: new Map(), byNameUnresolved: new Map(), implicit: new Map(), contract: new Set() };
  for (const f of files) for (const n of f.nodes) g.nodes.set(n.id, n);
  const link = (e: Edge) => {
    if (!g.nodes.has(e.to) || !g.nodes.has(e.from)) return;
    const o = g.out.get(e.from) ?? [], i = g.in.get(e.to) ?? [];
    if (o.some(x => x.to === e.to && x.line === e.line && x.reason === e.reason)) return;
    o.push(e); i.push(e);
    g.out.set(e.from, o); g.in.set(e.to, i);
  };
  const byName = new Map<string, NodeId[]>();
  for (const n of g.nodes.values()) byName.set(U(n.name), [...(byName.get(U(n.name)) ?? []), n.id]);

  for (const f of files) {
    for (const r of f.refs) link(r);
    for (const w of f.words) for (const to of byName.get(U(w.word)) ?? []) if (to !== w.from) link({ from: w.from, to, line: 0, reason: 'non-st' });
    for (const u of f.unresolved) g.byNameUnresolved.set(U(u.name), [...(g.byNameUnresolved.get(U(u.name)) ?? []), u.from]);
  }

  // class structure: interface implementations, overrides, contract members
  const objects = index.objects().filter(o => o.root && g.nodes.has(objectId(o)));
  const memberNames = (o: IndexedObject) => (o.root?.children ?? []).filter(c => MEMBER_KINDS.has(c.kind));
  const addImplicit = (key: NodeId, i: Implicit) => { g.implicit.set(key, [...(g.implicit.get(key) ?? []), i]); g.contract.add(i.member); };
  for (const o of objects) {
    if (o.root!.kind === 'INTERFACE') { for (const m of memberNames(o)) g.contract.add(memberId(o, m.name)); continue; }
    const unresolved: string[] = [];
    const chain = classChain(index, o, unresolved);
    const ifaces = interfaceClosure(index, chain.flatMap(c => c.root?.implements ?? []), unresolved);
    const owner = objectId(o);
    const own = memberNames(o);
    const findIn = (name: string) => chain.find(c => memberNames(c).some(m => U(m.name) === U(name)));
    // a base or interface outside the index: every member may be called through it
    if (unresolved.length) for (const m of own) g.contract.add(memberId(o, m.name));
    for (const itf of ifaces) {
      for (const im of memberNames(itf)) {
        const impl = findIn(im.name);
        if (impl) addImplicit(memberId(itf, im.name), { member: memberId(impl, im.name), owner, reason: 'interface' });
      }
    }
    for (const base of chain.slice(1)) {
      for (const bm of memberNames(base)) {
        const mine = own.find(m => U(m.name) === U(bm.name));
        if (mine) {
          addImplicit(memberId(base, bm.name), { member: memberId(o, mine.name), owner, reason: 'override' });
          g.contract.add(memberId(base, bm.name));                                        // the overridden member: removing it breaks the override
        }
      }
    }
  }
  return g;
}

export type ReachReason = 'root' | 'call' | 'interface' | 'override' | 'contract' | 'implicit' | 'by-name' | 'non-st';
export interface Reach { reachable: Map<NodeId, { via: NodeId | null; reason: ReachReason }> }

/** Fixed point: follow the edges, then apply the implicit rules, until nothing is added. */
export function reach(g: ObjectGraph, roots: NodeId[]): Reach {
  const reachable = new Map<NodeId, { via: NodeId | null; reason: ReachReason }>();
  const queue: NodeId[] = [];
  const mark = (id: NodeId, via: NodeId | null, reason: ReachReason) => {
    if (reachable.has(id) || !g.nodes.has(id)) return;
    reachable.set(id, { via, reason });
    queue.push(id);
  };
  for (const r of roots) mark(r, null, 'root');

  const membersByName = new Map<string, NodeId[]>();
  for (const n of g.nodes.values()) if (n.owner) membersByName.set(U(n.name), [...(membersByName.get(U(n.name)) ?? []), n.id]);
  const unresolvedOf = new Map<NodeId, string[]>();
  for (const [name, froms] of g.byNameUnresolved) for (const f of froms) unresolvedOf.set(f, [...(unresolvedOf.get(f) ?? []), name]);
  const contractOf = new Map<NodeId, NodeId[]>();
  for (const c of g.contract) { const o = g.nodes.get(c)?.owner; if (o) contractOf.set(o, [...(contractOf.get(o) ?? []), c]); }
  const membersOf = new Map<NodeId, NodeId[]>();
  for (const n of g.nodes.values()) if (n.owner) membersOf.set(n.owner, [...(membersOf.get(n.owner) ?? []), n.id]);

  for (;;) {
    while (queue.length) {
      const id = queue.shift()!;
      const node = g.nodes.get(id)!;
      for (const e of g.out.get(id) ?? []) mark(e.to, id, e.reason === 'non-st' ? 'non-st' : 'call');
      if (node.owner) mark(node.owner, id, 'call');                                           // using a member uses its object
      for (const name of unresolvedOf.get(id) ?? []) for (const m of membersByName.get(name) ?? []) mark(m, id, 'by-name');
      if (!node.owner) {
        for (const c of contractOf.get(id) ?? []) mark(c, id, 'contract');                    // callbacks and event handlers
        for (const m of membersOf.get(id) ?? []) if (INIT_METHODS.has(U(g.nodes.get(m)!.name))) mark(m, id, 'implicit');
      }
    }
    let changed = false;
    for (const [key, list] of g.implicit) {
      if (!reachable.has(key)) continue;
      for (const i of list) {
        if (!reachable.has(i.owner) || reachable.has(i.member)) continue;
        mark(i.member, key, i.reason);
        changed = true;
      }
    }
    if (!changed && !queue.length) break;
  }
  return { reachable };
}

/** Path from a root to the node: the root first, each with the reason it was reached. */
export function whyReachable(r: Reach, id: NodeId): { id: NodeId; reason: string }[] {
  const path: { id: NodeId; reason: string }[] = [];
  const seen = new Set<NodeId>();
  for (let cur: NodeId | null = id; cur !== null && !seen.has(cur); ) {
    seen.add(cur);
    const rec = r.reachable.get(cur);
    if (!rec) break;
    path.unshift({ id: cur, reason: rec.reason });
    cur = rec.via;
  }
  return path;
}

export interface UnusedFinding { id: NodeId; confidence: 'unreferenced' | 'only-from-unused' }

/**
 * Nodes that no root reaches. Library nodes, contract members (implementing an interface member or overriding a base member)
 * and members of an unused object (the object carries the finding) are never listed.
 */
export function findUnused(g: ObjectGraph, r: Reach): UnusedFinding[] {
  const out: UnusedFinding[] = [];
  for (const n of g.nodes.values()) {
    if (n.library || r.reachable.has(n.id) || g.contract.has(n.id)) continue;
    if (n.owner && !r.reachable.has(n.owner)) continue;
    out.push({ id: n.id, confidence: (g.in.get(n.id) ?? []).some(e => e.from !== n.id) ? 'only-from-unused' : 'unreferenced' });
  }
  return out;
}

/** Nodes with an edge to `id`, each once. */
export function callersOf(g: ObjectGraph, id: NodeId): NodeId[] {
  return [...new Set((g.in.get(id) ?? []).map(e => e.from))];
}

/** The roots from which `id` is reachable. */
export function reachedFrom(g: ObjectGraph, id: NodeId, roots: NodeId[]): NodeId[] {
  return roots.filter(root => reach(g, [root]).reachable.has(id));
}
