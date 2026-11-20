// Object-oriented checks on function blocks: which abstract members of the base classes and which members of the
// implemented interfaces a function block still has to implement, and stubs (IECode view sections) that implement them.

import { IndexedObject, SymbolIndex } from './index';
import { PlcSymbol } from './parser';
import { parseView } from '../model';

const U = (s: string) => s.toUpperCase();
const OO_KINDS = new Set(['METHOD', 'PROPERTY']);

export interface MissingMember {
  name: string;
  kind: 'METHOD' | 'PROPERTY';
  /** Interface or base function block that declares the member. */
  source: IndexedObject;
  symbol: PlcSymbol;
  reason: 'interface' | 'abstract';
}

export interface MissingResult {
  missing: MissingMember[];
  /** Base classes or interfaces that are not in the index (the check is incomplete for them). */
  unresolved: string[];
}

const isAbstract = (s: PlcSymbol) => !!s.modifiers?.includes('ABSTRACT');

/** The function block and its base classes, most derived first. */
export function classChain(index: SymbolIndex, obj: IndexedObject, unresolved: string[] = []): IndexedObject[] {
  const out: IndexedObject[] = [];
  const seen = new Set<string>();
  let cur: IndexedObject | undefined = obj;
  while (cur?.root && !seen.has(U(cur.root.name))) {
    seen.add(U(cur.root.name));
    out.push(cur);
    const base: string | undefined = cur.root.extends?.[0];
    if (!base) break;
    cur = index.find(base);
    if (!cur?.root) unresolved.push(base);
  }
  return out;
}

/** An interface and the interfaces it extends (each once). */
export function interfaceClosure(index: SymbolIndex, names: string[], unresolved: string[], seen = new Set<string>()): IndexedObject[] {
  const out: IndexedObject[] = [];
  for (const n of names) {
    const o = index.find(n);
    if (!o?.root || o.root.kind !== 'INTERFACE') { if (!o?.root) unresolved.push(n); continue; }
    if (seen.has(U(o.root.name))) continue;
    seen.add(U(o.root.name));
    out.push(o, ...interfaceClosure(index, o.root.extends ?? [], unresolved, seen));
  }
  return out;
}

/**
 * Methods and properties a function block must still implement: abstract members of its base classes that no class in
 * the chain implements, and members of every interface implemented by it or a base class (including interfaces those extend).
 */
export function missingMembers(index: SymbolIndex, obj: IndexedObject): MissingResult {
  const unresolved: string[] = [];
  if (obj.root?.kind !== 'FUNCTION_BLOCK') return { missing: [], unresolved };
  const chain = classChain(index, obj, unresolved);
  const implemented = new Set<string>();
  for (const c of chain)
    for (const m of c.root!.children) if (OO_KINDS.has(m.kind) && !isAbstract(m)) implemented.add(U(m.name));

  const missing: MissingMember[] = [];
  const add = (source: IndexedObject, symbol: PlcSymbol, reason: MissingMember['reason']) => {
    const n = U(symbol.name);
    if (implemented.has(n) || missing.some(m => U(m.name) === n)) return;
    missing.push({ name: symbol.name, kind: symbol.kind as MissingMember['kind'], source, symbol, reason });
  };
  for (const c of chain)
    for (const m of c.root!.children) if (OO_KINDS.has(m.kind) && isAbstract(m)) add(c, m, 'abstract');
  const itfs = interfaceClosure(index, chain.flatMap(c => c.root!.implements ?? []), unresolved);
  for (const i of itfs) for (const m of i.root!.children) if (OO_KINDS.has(m.kind)) add(i, m, 'interface');
  return { missing, unresolved: [...new Set(unresolved)] };
}

/** One-line description of missing members for a diagnostic. */
export function describeMissing(obj: IndexedObject, missing: MissingMember[]): string {
  const list = missing.map(m => `${m.source.root!.name}.${m.name}${m.reason === 'abstract' ? ' (abstract)' : ''}`);
  const shown = list.length > 6 ? [...list.slice(0, 6), `… ${list.length - 6} more`] : list;
  return `${obj.root!.name} does not implement ${missing.length === 1 ? 'member' : `${missing.length} members`}: ${shown.join(', ')}`;
}

const HEAD_RE = /^(\s*(?:METHOD|PROPERTY)\s+)((?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)*)/i;

/** The member's header with ABSTRACT removed and PUBLIC added when no access is given (interface members). */
function stubDeclaration(decl: string): string {
  const lines = decl.replace(/\n+$/, '').split('\n');
  const i = lines.findIndex(l => HEAD_RE.test(l));
  if (i >= 0) {
    lines[i] = lines[i].replace(HEAD_RE, (_m, head: string, mods: string) => {
      const kept = mods.split(/\s+/).filter(x => x && U(x) !== 'ABSTRACT');
      if (!kept.some(x => ['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL'].includes(U(x)))) kept.unshift('PUBLIC');
      return head + kept.map(x => x + ' ').join('');
    });
  }
  return lines.join('\n');
}

/** IECode view sections that implement the given members (methods with an empty body, properties with their accessors). */
export function memberStubs(missing: MissingMember[]): string {
  let out = '';
  for (const m of missing) {
    const secs = parseView(m.source.view);
    const sec = secs.find(s => s.kind === m.kind && U(s.name) === U(m.name));
    const decl = stubDeclaration(sec?.decl ?? `${m.kind} ${m.name}${m.symbol.type ? ' : ' + m.symbol.type : ''}`);
    if (m.kind === 'METHOD') {
      out += `//==== METHOD ${m.name} ====\n${decl}\n//---- IMPLEMENTATION ----\n`;
    } else {
      out += `//==== PROPERTY ${m.name} ====\n${decl}\n`;
      const accessors = m.symbol.accessors?.length ? m.symbol.accessors : ['GET' as const];
      for (const a of accessors) out += `//==== ${a} ${m.name} ====\nVAR\nEND_VAR\n//---- IMPLEMENTATION ----\n`;
    }
  }
  return out;
}
