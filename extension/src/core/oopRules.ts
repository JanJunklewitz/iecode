// Object-oriented rules between objects, read from the symbol index of one PLC project (decoded ST views, not XML).
// `missing-implementation` is not here: lang/providers.ts already publishes it with a quick fix.
//
// `fb-init-super` (a derived FB_init without SUPER^.FB_init) was dropped: it is unverified whether TwinCAT calls the
// base FB_init implicitly or requires the explicit call, and a wrong rule would tell people to run it twice.

import { IndexedObject, SymbolIndex, baseTypeName } from '../lang/index';
import { classChain, interfaceClosure } from '../lang/inheritance';
import { PlcSymbol, Range } from '../lang/parser';
import { Finding, Level, RuleInfo, textVersion } from './findings';

export const OOP_RULES: RuleInfo[] = [
  { id: 'signature-mismatch', description: 'An override or interface implementation differs in return type or parameters', level: 'error' },
  { id: 'final-violation', description: 'EXTENDS of a FINAL function block, or an override of a FINAL method', level: 'error' },
  { id: 'abstract-instantiation', description: 'A variable (not a pointer, reference or VAR_IN_OUT) has an ABSTRACT function block type', level: 'error' },
  { id: 'unresolved-base', description: 'A base or interface is not in the project: the rules above could not be checked for it', level: 'info' },
];

const U = (s: string) => s.toUpperCase();
/** A POINTER or REFERENCE, also as the element type of an array: it holds no instance itself. */
const isIndirect = (type: string) => /^(?:POINTER|REFERENCE)\b/i.test(type.trim().replace(/^(?:ARRAY\s*\[[^\]]*\]\s*OF\s+)+/i, ''));
/** Methods TwinCAT calls itself: a derived FB_init may add parameters, so their signatures are free. */
const LIFECYCLE = new Set(['FB_INIT', 'FB_REINIT', 'FB_EXIT']);
const PARAM_SCOPES = new Set(['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT']);
const norm = (t: string | undefined) => (t ?? '').replace(/\s+/g, '').toUpperCase();
const hasModifier = (s: PlcSymbol, m: string) => !!s.modifiers?.includes(m);

/** Same return type and the same VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT list (name, type, order; case-insensitive). */
export function sameSignature(a: PlcSymbol, b: PlcSymbol): boolean {
  return signatureKey(a) === signatureKey(b);
}

const params = (m: PlcSymbol) => m.children.filter(c => c.kind === 'VARIABLE' && c.scope && PARAM_SCOPES.has(c.scope));
const signatureKey = (m: PlcSymbol) => `${norm(m.type)}(${params(m).map(p => `${p.scope}:${U(p.name)}:${norm(p.type)}`).join(',')})`;

/** `FB_A.Run(VAR_INPUT a : INT) : BOOL`, for the message. */
function describe(owner: string, m: PlcSymbol): string {
  const list = params(m).map(p => `${p.scope} ${p.name} : ${p.type ?? '?'}`).join('; ');
  return `${owner}.${m.name}(${list})${m.type ? ` : ${m.type}` : ''}`;
}

export function checkOop(index: SymbolIndex, obj: IndexedObject): Finding[] {
  const root = obj.root;
  if (!root || obj.library) return [];
  const version = textVersion(obj.view);
  const out: Finding[] = [];
  const add = (rule: string, level: Level, message: string, r: Range) =>
    out.push({ rule, level, message, file: obj.file, space: 'view', version, line: r.line, col: r.col, endLine: r.endLine, endCol: r.endCol });
  const level = (id: string) => OOP_RULES.find(r => r.id === id)!.level as Level;

  const unresolved: string[] = [];
  if (root.kind === 'FUNCTION_BLOCK') {
    const chain = classChain(index, obj, unresolved);
    const bases = chain.slice(1);
    const members = (o: IndexedObject) => (o.root?.children ?? []).filter(c => c.kind === 'METHOD' || c.kind === 'PROPERTY');
    const own = members(obj);

    // EXTENDS of a FINAL block
    const base = bases[0];
    if (base?.root && hasModifier(base.root, 'FINAL'))
      add('final-violation', level('final-violation'), `${root.name} extends ${base.root.name}, which is FINAL`, root.range);

    // overrides: the nearest base member of the same name
    for (const m of own) {
      const hit = bases.map(b => ({ b, sym: members(b).find(x => x.kind === m.kind && U(x.name) === U(m.name)) })).find(x => x.sym);
      if (!hit?.sym) continue;
      if (hasModifier(hit.sym, 'FINAL')) add('final-violation', level('final-violation'), `${root.name}.${m.name} overrides ${hit.b.root!.name}.${m.name}, which is FINAL`, m.range);
      else if (!LIFECYCLE.has(U(m.name)) && !sameSignature(m, hit.sym))
        add('signature-mismatch', level('signature-mismatch'), `${describe(root.name, m)} does not match the overridden ${describe(hit.b.root!.name, hit.sym)}`, m.range);
    }

    // interfaces this block lists itself; the implementation may come from a base class (then the block is reported)
    for (const itf of interfaceClosure(index, root.implements ?? [], unresolved)) {
      for (const im of members(itf)) {
        const owner = chain.find(c => members(c).some(x => x.kind === im.kind && U(x.name) === U(im.name)));
        const impl = owner && members(owner).find(x => x.kind === im.kind && U(x.name) === U(im.name));
        if (!owner || !impl || sameSignature(impl, im)) continue;
        // a base that lists the same interface reports its own mismatch
        if (owner !== obj && interfaceClosure(index, owner.root?.implements ?? [], []).some(i => U(i.root!.name) === U(itf.root!.name))) continue;
        add('signature-mismatch', level('signature-mismatch'),
          `${describe(owner.root!.name, impl)} does not match ${describe(itf.root!.name, im)}`, owner === obj ? impl.range : root.range);
      }
    }
  }

  // an ABSTRACT block cannot be instantiated: variables of every object and member
  const visit = (s: PlcSymbol) => {
    for (const c of s.children) {
      if (c.kind === 'VARIABLE' && c.scope !== 'VAR_IN_OUT' && c.type && !isIndirect(c.type)) {
        const t = baseTypeName(c.type);
        const target = t ? index.find(t) : undefined;
        if (target?.root?.kind === 'FUNCTION_BLOCK' && hasModifier(target.root, 'ABSTRACT'))
          add('abstract-instantiation', level('abstract-instantiation'), `${c.name} is an instance of ${target.root.name}, which is ABSTRACT`, c.range);
      } else if (c.kind !== 'VARIABLE') visit(c);
    }
  };
  visit(root);

  if (unresolved.length)
    add('unresolved-base', level('unresolved-base'), `${[...new Set(unresolved)].join(', ')} not found in this project: inheritance rules not checked for it`, root.range);
  return out;
}
