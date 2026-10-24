// Workspace symbol index and name resolution for go-to-definition, references, rename, hover and completion.
// Works on the IECode view text, so positions match the plain-ST editor.

import { tokenize, wordAt, ELEMENTARY_TYPES, KEYWORDS } from './lexer';
import { parseObject, ParsedObject, PlcSymbol, Range, sections } from './parser';

export interface IndexedObject { file: string; view: string; parsed: ParsedObject; root?: PlcSymbol }
export interface Location { file: string; range: Range; symbol: PlcSymbol; owner?: PlcSymbol }

const U = (s: string) => s.toUpperCase();
const MEMBER_KINDS = new Set(['METHOD', 'PROPERTY', 'ACTION', 'TRANSITION']);

/** Strips POINTER TO / REFERENCE TO / ARRAY[..] OF / STRING(n) to the type name that has members. */
export function baseTypeName(type: string | undefined): string | undefined {
  if (!type) return undefined;
  let t = type.trim();
  for (;;) {
    const m = /^(?:POINTER\s+TO|REFERENCE\s+TO|ARRAY\s*\[[^\]]*\]\s*OF)\s+(.+)$/i.exec(t);
    if (!m) break;
    t = m[1].trim();
  }
  return t.replace(/\(.*\)$/, '').trim() || undefined;
}

export class SymbolIndex {
  private readonly byFile = new Map<string, IndexedObject>();
  private readonly byName = new Map<string, IndexedObject>();

  /** Adds or replaces an object from its view text. */
  update(file: string, view: string): IndexedObject {
    this.remove(file);
    const name = file.split(/[\\/]/).pop()!.replace(/\.\w+$/, '');
    const parsed = parseObject(view, name);
    const obj: IndexedObject = { file, view, parsed, root: parsed.root };
    this.byFile.set(file, obj);
    if (obj.root) this.byName.set(U(obj.root.name), obj);
    return obj;
  }

  remove(file: string) {
    const old = this.byFile.get(file);
    if (!old) return;
    this.byFile.delete(file);
    if (old.root && this.byName.get(U(old.root.name)) === old) this.byName.delete(U(old.root.name));
  }

  get(file: string) { return this.byFile.get(file); }
  objects() { return [...this.byFile.values()]; }
  find(name: string) { return this.byName.get(U(name)); }

  /** Members, variables, fields and enum values of a type, following EXTENDS. */
  membersOf(typeName: string | undefined, seen = new Set<string>()): { sym: PlcSymbol; obj: IndexedObject }[] {
    const t = baseTypeName(typeName);
    const obj = t ? this.find(t) : undefined;
    if (!obj?.root || seen.has(U(obj.root.name))) return [];
    seen.add(U(obj.root.name));
    const own = obj.root.children.map(sym => ({ sym, obj }));
    const inherited = (obj.root.extends ?? []).flatMap(b => this.membersOf(b, seen));
    return [...own, ...inherited.filter(i => !own.some(o => U(o.sym.name) === U(i.sym.name)))];
  }

  /** The member (method / property / action) whose section contains a line, if any. */
  private sectionMember(obj: IndexedObject, line: number): PlcSymbol | undefined {
    return obj.root?.children.find(c => MEMBER_KINDS.has(c.kind) && line >= c.full.line && line <= c.full.endLine);
  }

  private loc(obj: IndexedObject, sym: PlcSymbol, owner?: PlcSymbol): Location {
    return { file: obj.file, range: sym.range, symbol: sym, owner };
  }

  /** Resolves the identifier at a position (line/col in the view) to its declaration. */
  resolve(file: string, line: number, col: number): Location | undefined {
    const obj = this.byFile.get(file);
    if (!obj) return undefined;
    const lines = obj.view.split('\n');
    if (/^\/\/(====|----)/.test(lines[line] ?? '')) return undefined;
    const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
    if (this.inTrivia(obj.view, offset)) return undefined;
    const w = wordAt(obj.view, offset);
    if (!w || KEYWORDS.has(U(w.word)) || ELEMENTARY_TYPES.has(U(w.word))) return undefined;
    const chain = [...w.qualifier, w.word];
    const member = this.sectionMember(obj, line);

    // first part of the chain
    let cur = this.resolveFirst(obj, member, chain[0]);
    for (let i = 1; cur && i < chain.length; i++) cur = this.resolveMember(cur, chain[i], obj);
    return cur;
  }

  private resolveFirst(obj: IndexedObject, member: PlcSymbol | undefined, name: string): Location | undefined {
    const n = U(name);
    const root = obj.root;
    if (n === 'THIS' && root) return this.loc(obj, root);
    if (n === 'SUPER' && root?.extends?.[0]) { const b = this.find(root.extends[0]); if (b?.root) return this.loc(b, b.root); }
    const local = member?.children.find(v => U(v.name) === n);
    if (local) return this.loc(obj, local, member);
    if (member && U(member.name) === n) return this.loc(obj, member, root);           // function / method result variable
    if (root && (root.kind === 'FUNCTION') && U(root.name) === n) return this.loc(obj, root);
    const own = root?.children.find(c => U(c.name) === n);
    if (own) return this.loc(obj, own, root);
    if (root) {
      const inherited = this.membersOf(root.extends?.[0]).find(m => U(m.sym.name) === n);
      if (inherited) return this.loc(inherited.obj, inherited.sym, inherited.obj.root);
    }
    const global = this.find(name);
    if (global?.root) return this.loc(global, global.root);
    for (const o of this.byFile.values()) {
      if (o.root?.kind !== 'GVL') continue;
      const v = o.root.children.find(c => U(c.name) === n);
      if (v) return this.loc(o, v, o.root);
    }
    return undefined;
  }

  private resolveMember(of: Location, name: string, _ctx: IndexedObject): Location | undefined {
    const n = U(name);
    const s = of.symbol;
    // A type / GVL / enum name: look inside it. A variable / property / method: look inside its type.
    const typeName = ['VARIABLE', 'FIELD', 'PROPERTY', 'METHOD'].includes(s.kind) ? s.type : s.name;
    const hit = this.membersOf(typeName).find(m => U(m.sym.name) === n);
    return hit ? this.loc(hit.obj, hit.sym, hit.obj.root) : undefined;
  }

  private inTrivia(view: string, offset: number): boolean {
    return tokenize(view, true).some(t => (t.type === 'comment' || t.type === 'string' || t.type === 'pragma') && offset >= t.offset && offset < t.offset + t.text.length);
  }

  /** All identifier occurrences in the workspace that resolve to the same declaration (including the declaration). */
  references(target: Location): { file: string; range: Range }[] {
    const out: { file: string; range: Range }[] = [];
    const same = (l?: Location) => !!l && l.file === target.file && l.range.line === target.range.line && l.range.col === target.range.col;
    const name = U(target.symbol.name);
    for (const o of this.byFile.values()) {
      for (const t of tokenize(o.view)) {
        if (t.type !== 'ident' || t.upper !== name) continue;
        if (same(this.resolve(o.file, t.line, t.col))) out.push({ file: o.file, range: { line: t.line, col: t.col, endLine: t.line, endCol: t.col + t.text.length } });
      }
      // section headers name methods / properties / actions: //==== METHOD Start ====
      for (const s of sections(o.view).slice(1)) {
        if (U(s.name) !== name || !target.owner || o.root?.name !== target.owner.name) continue;
        const line = o.view.split('\n')[s.headerLine];
        const col = line.lastIndexOf(s.name);
        out.push({ file: o.file, range: { line: s.headerLine, col, endLine: s.headerLine, endCol: col + s.name.length } });
      }
    }
    if (!out.some(r => r.file === target.file && r.range.line === target.range.line && r.range.col === target.range.col))
      out.unshift({ file: target.file, range: target.range });
    return out;
  }

  /** Completion candidates at a position: members after '.', otherwise locals, own members, objects, GVL vars, keywords. */
  completions(file: string, line: number, col: number): { label: string; kind: PlcSymbol['kind'] | 'KEYWORD' | 'TYPE'; detail?: string }[] {
    const obj = this.byFile.get(file);
    if (!obj) return [];
    const lines = obj.view.split('\n');
    const before = (lines[line] ?? '').slice(0, col);
    const dotted = /([A-Za-z_][\w.]*)\.\w*$/.exec(before);
    if (dotted) {
      const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col - (before.length - before.lastIndexOf('.'));
      const qLoc = this.resolve(file, line, offset - lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0));
      if (!qLoc) return [];
      const s = qLoc.symbol;
      const typeName = ['VARIABLE', 'FIELD', 'PROPERTY', 'METHOD'].includes(s.kind) ? s.type : s.name;
      return this.membersOf(typeName)
        .filter(m => m.sym.scope !== 'VAR' && m.sym.scope !== 'VAR_TEMP' && m.sym.scope !== 'VAR_INST')   // only the public face
        .map(m => ({ label: m.sym.name, kind: m.sym.kind, detail: m.sym.type ?? m.sym.detail }));
    }
    const member = this.sectionMember(obj, line);
    const seen = new Set<string>();
    const out: ReturnType<SymbolIndex['completions']> = [];
    const add = (label: string, kind: ReturnType<SymbolIndex['completions']>[number]['kind'], detail?: string) => {
      if (seen.has(U(label))) return;
      seen.add(U(label));
      out.push({ label, kind, detail });
    };
    member?.children.forEach(v => add(v.name, v.kind, v.type));
    obj.root?.children.forEach(v => add(v.name, v.kind, v.type ?? v.detail));
    this.membersOf(obj.root?.extends?.[0]).forEach(m => add(m.sym.name, m.sym.kind, m.sym.type));
    for (const o of this.byFile.values()) if (o.root) add(o.root.name, o.root.kind, o.root.detail);
    ELEMENTARY_TYPES.forEach(t => add(t, 'TYPE'));
    KEYWORDS.forEach(k => add(k, 'KEYWORD'));
    return out;
  }
}
