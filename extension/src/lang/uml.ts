// UML class diagrams of function blocks and interfaces, built from the symbol index:
// a model (classes + relations), Mermaid / PlantUML text and a self-contained SVG.

import { IndexedObject, SymbolIndex, baseTypeName } from './index';

const U = (s: string) => s.toUpperCase();

export type UmlDetail = 'full' | 'members' | 'names';

export interface UmlAttribute { name: string; type: string; visibility: string; scope: string }
export interface UmlOperation { name: string; kind: 'METHOD' | 'PROPERTY' | 'ACTION'; params: string; type?: string; visibility: string; abstract: boolean }
export interface UmlClass {
  name: string;
  kind: 'FUNCTION_BLOCK' | 'INTERFACE' | 'PROGRAM';
  abstract: boolean;
  /** Declared outside the selection (a library or another project): drawn without members. */
  external: boolean;
  library?: string;
  file?: string;
  attributes: UmlAttribute[];
  operations: UmlOperation[];
}
export interface UmlRelation { from: string; to: string; kind: 'extends' | 'implements' | 'composition'; label?: string }
export interface UmlModel { classes: UmlClass[]; relations: UmlRelation[] }

const CLASS_KINDS = new Set(['FUNCTION_BLOCK', 'INTERFACE', 'PROGRAM']);
const VISIBILITY: Record<string, string> = { PUBLIC: '+', PRIVATE: '-', PROTECTED: '#', INTERNAL: '~' };
/** Inputs, outputs and in-outs are the public face of a function block; other variables are internal state. */
const VAR_VISIBILITY: Record<string, string> = { VAR_INPUT: '+', VAR_OUTPUT: '+', VAR_IN_OUT: '+', VAR: '-', VAR_STAT: '-', VAR_INST: '-' };

function toClass(o: IndexedObject, external: boolean): UmlClass {
  const r = o.root!;
  const attributes: UmlAttribute[] = [];
  const operations: UmlOperation[] = [];
  if (!external) {
    for (const c of r.children) {
      if (c.kind === 'VARIABLE' && c.scope && VAR_VISIBILITY[c.scope])
        attributes.push({ name: c.name, type: c.type ?? '?', visibility: VAR_VISIBILITY[c.scope], scope: c.scope });
      if (c.kind === 'METHOD' || c.kind === 'PROPERTY' || c.kind === 'ACTION')
        operations.push({
          name: c.name, kind: c.kind, type: c.type,
          params: c.kind === 'METHOD' ? c.children.filter(v => v.scope === 'VAR_INPUT' || v.scope === 'VAR_IN_OUT').map(v => `${v.name} : ${v.type ?? '?'}`).join(', ') : '',
          visibility: r.kind === 'INTERFACE' ? '+' : VISIBILITY[c.access ?? 'PUBLIC'] ?? '+',
          abstract: !!c.modifiers?.includes('ABSTRACT'),
        });
    }
  }
  return {
    name: r.name, kind: r.kind as UmlClass['kind'], abstract: !!r.modifiers?.includes('ABSTRACT'), external,
    library: o.library, file: o.library ? undefined : o.file, attributes, operations,
  };
}

export interface UmlScope {
  /** Objects whose classes are drawn in full. */
  files?: Set<string>;
  /** Center the diagram on these classes: their base classes, interfaces, derived classes and composed classes. */
  focus?: string[];
}

/** Builds the diagram model for a set of files (or the whole index), or around focus classes. */
export function umlModel(index: SymbolIndex, scope: UmlScope = {}): UmlModel {
  const all = index.objects().filter(o => o.root && CLASS_KINDS.has(o.root.kind));
  const byName = (n: string) => { const o = index.find(baseTypeName(n) ?? n); return o?.root && CLASS_KINDS.has(o.root.kind) ? o : undefined; };
  const chosen = new Map<string, IndexedObject>();
  const take = (o: IndexedObject) => chosen.set(U(o.root!.name), o);

  if (scope.focus?.length) {
    const up = (o: IndexedObject, seen: Set<string>) => {
      if (seen.has(U(o.root!.name))) return;
      seen.add(U(o.root!.name));
      take(o);
      for (const n of [...(o.root!.extends ?? []), ...(o.root!.implements ?? [])]) { const b = byName(n); if (b) up(b, seen); }
    };
    const down = (name: string, seen: Set<string>) => {
      for (const o of all) {
        const r = o.root!;
        if (seen.has(U(r.name))) continue;
        if ([...(r.extends ?? []), ...(r.implements ?? [])].some(n => U(baseTypeName(n) ?? n) === U(name))) { seen.add(U(r.name)); take(o); down(r.name, seen); }
      }
    };
    for (const f of scope.focus) {
      const o = byName(f);
      if (!o) continue;
      up(o, new Set());
      down(o.root!.name, new Set([U(o.root!.name)]));
      // classes the focused one is composed of
      for (const v of o.root!.children) if (v.kind === 'VARIABLE' && v.type) { const t = byName(v.type); if (t && t.root!.kind === 'FUNCTION_BLOCK') take(t); }
    }
  } else {
    for (const o of all) if (!scope.files || scope.files.has(o.file)) take(o);
  }

  // bases and interfaces outside the selection are drawn as external boxes
  const external = new Map<string, IndexedObject>();
  for (const o of chosen.values())
    for (const n of [...(o.root!.extends ?? []), ...(o.root!.implements ?? [])]) {
      const b = byName(n);
      if (b && !chosen.has(U(b.root!.name))) external.set(U(b.root!.name), b);
    }
  const inScope = (o: IndexedObject) => !scope.files || scope.files.has(o.file) || !!scope.focus?.length;
  const classes = [
    ...[...chosen.values()].map(o => toClass(o, !!o.library || !inScope(o))),
    ...[...external.values()].map(o => toClass(o, true)),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(classes.map(c => [U(c.name), c.name]));

  const relations: UmlRelation[] = [];
  for (const o of [...chosen.values(), ...external.values()]) {
    const r = o.root!;
    const rel = (n: string, kind: UmlRelation['kind'], label?: string) => {
      const to = names.get(U(byName(n)?.root!.name ?? baseTypeName(n) ?? n));
      if (to && !relations.some(x => x.from === r.name && x.to === to && x.kind === kind && x.label === label)) relations.push({ from: r.name, to, kind, label });
    };
    for (const n of r.extends ?? []) rel(n, 'extends');
    for (const n of r.implements ?? []) rel(n, 'implements');
    if (chosen.has(U(r.name)))
      for (const v of r.children)
        if (v.kind === 'VARIABLE' && v.type && byName(v.type) && !/^(POINTER|REFERENCE)\s+TO/i.test(v.type) && byName(v.type)!.root!.kind !== 'INTERFACE')
          rel(v.type, 'composition', v.name);
  }
  return { classes, relations };
}

// ------------------------------------------------------------------ text formats

const opText = (o: UmlOperation) => o.kind === 'METHOD' ? `${o.name}(${o.params})${o.type ? ' : ' + o.type : ''}` : `${o.name} : ${o.type ?? '?'}`;
const attrsOf = (c: UmlClass, d: UmlDetail) => d === 'full' ? c.attributes : [];
const opsOf = (c: UmlClass, d: UmlDetail) => d === 'names' ? [] : c.operations;
const safe = (s: string) => s.replace(/[^\w]/g, '_');

/** Mermaid classDiagram text. */
export function toMermaid(m: UmlModel, detail: UmlDetail = 'members'): string {
  const L = ['classDiagram'];
  for (const c of m.classes) {
    const attrs = attrsOf(c, detail), ops = opsOf(c, detail);
    const stereo = c.kind === 'INTERFACE' ? '<<interface>>' : c.kind === 'PROGRAM' ? '<<program>>' : c.abstract ? '<<abstract>>' : c.external ? '<<library>>' : '';
    L.push(`  class ${safe(c.name)} {`);
    if (stereo) L.push(`    ${stereo}`);
    for (const a of attrs) L.push(`    ${a.visibility}${a.name} : ${a.type}`);
    for (const o of ops) {
      if (o.kind === 'METHOD') L.push(`    ${o.visibility}${o.name}(${o.params})${o.abstract ? '*' : ''}${o.type ? ' ' + o.type : ''}`);
      else L.push(`    ${o.visibility}${o.name} : ${o.type ?? '?'}`);
    }
    L.push('  }');
  }
  for (const r of m.relations) {
    const arrow = r.kind === 'extends' ? '<|--' : r.kind === 'implements' ? '<|..' : '*--';
    if (r.kind === 'composition') L.push(`  ${safe(r.from)} ${arrow} ${safe(r.to)} : ${r.label}`);
    else L.push(`  ${safe(r.to)} ${arrow} ${safe(r.from)}`);
  }
  return L.join('\n') + '\n';
}

/** PlantUML class diagram text. */
export function toPlantUml(m: UmlModel, detail: UmlDetail = 'members'): string {
  const L = ['@startuml', 'hide empty members', 'skinparam classAttributeIconSize 0'];
  for (const c of m.classes) {
    const keyword = c.kind === 'INTERFACE' ? 'interface' : c.abstract ? 'abstract class' : 'class';
    const stereo = c.kind === 'PROGRAM' ? ' <<program>>' : c.external && c.library ? ` <<${c.library}>>` : '';
    const attrs = attrsOf(c, detail), ops = opsOf(c, detail);
    if (!attrs.length && !ops.length) { L.push(`${keyword} ${c.name}${stereo}`); continue; }
    L.push(`${keyword} ${c.name}${stereo} {`);
    for (const a of attrs) L.push(`  ${a.visibility}${a.name} : ${a.type}`);
    if (attrs.length && ops.length) L.push('  --');
    for (const o of ops) L.push(`  ${o.abstract ? '{abstract} ' : ''}${o.visibility}${opText(o)}`);
    L.push('}');
  }
  for (const r of m.relations) {
    if (r.kind === 'extends') L.push(`${r.to} <|-- ${r.from}`);
    else if (r.kind === 'implements') L.push(`${r.to} <|.. ${r.from}`);
    else L.push(`${r.from} *-- ${r.to} : ${r.label}`);
  }
  L.push('@enduml');
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ SVG

export interface Box { cls: UmlClass; x: number; y: number; w: number; h: number; lines: { text: string; kind: 'stereo' | 'name' | 'sep' | 'attr' | 'op'; abstract?: boolean }[] }

const CHAR_W = 7.2, LINE_H = 17, PAD = 8, GAP_X = 90, GAP_Y = 70;
const xmlEsc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Layered layout: base classes and interfaces above the classes that extend or implement them. */
export function layout(m: UmlModel, detail: UmlDetail = 'members'): { boxes: Box[]; width: number; height: number } {
  const parents = new Map<string, string[]>();
  for (const r of m.relations) if (r.kind !== 'composition') (parents.get(r.from) ?? parents.set(r.from, []).get(r.from)!).push(r.to);
  const level = new Map<string, number>();
  const depth = (n: string, stack = new Set<string>()): number => {
    if (level.has(n)) return level.get(n)!;
    if (stack.has(n)) return 0;
    stack.add(n);
    const ps = parents.get(n) ?? [];
    const d = ps.length ? Math.max(...ps.map(p => depth(p, stack))) + 1 : 0;
    level.set(n, d);
    return d;
  };
  m.classes.forEach(c => depth(c.name));
  // parts outside any hierarchy sit on their owner's row (composition drawn side by side)
  const inHierarchy = new Set(m.relations.filter(r => r.kind !== 'composition').flatMap(r => [r.from, r.to]));
  for (const r of m.relations)
    if (r.kind === 'composition' && !inHierarchy.has(r.to) && r.from !== r.to) level.set(r.to, Math.max(level.get(r.to) ?? 0, level.get(r.from) ?? 0));

  const boxes = new Map<string, Box>();
  for (const c of m.classes) {
    const lines: Box['lines'] = [];
    const stereo = c.kind === 'INTERFACE' ? '«interface»' : c.kind === 'PROGRAM' ? '«program»' : c.abstract ? '«abstract»' : '';
    if (stereo) lines.push({ text: stereo, kind: 'stereo' });
    lines.push({ text: c.name, kind: 'name', abstract: c.abstract });
    if (c.external && c.library) lines.push({ text: c.library, kind: 'stereo' });
    const attrs = attrsOf(c, detail), ops = opsOf(c, detail);
    if (attrs.length) { lines.push({ text: '', kind: 'sep' }); attrs.forEach(a => lines.push({ text: `${a.visibility} ${a.name} : ${a.type}`, kind: 'attr' })); }
    if (ops.length) { lines.push({ text: '', kind: 'sep' }); ops.forEach(o => lines.push({ text: `${o.visibility} ${opText(o)}`, kind: 'op', abstract: o.abstract })); }
    const w = Math.max(120, Math.min(420, Math.max(...lines.map(l => l.text.length)) * CHAR_W + 2 * PAD));
    const h = lines.reduce((n, l) => n + (l.kind === 'sep' ? 6 : LINE_H), 0) + 2 * PAD;
    boxes.set(c.name, { cls: c, x: 0, y: 0, w, h, lines });
  }

  // rows by level; order each row by the mean position of its parents to keep edges short
  const rows: string[][] = [];
  for (const c of m.classes) (rows[level.get(c.name) ?? 0] ??= []).push(c.name);
  const center = new Map<string, number>();
  let y = 20, width = 0;
  for (const row of rows.filter(Boolean)) {
    const key = (n: string) => { const ps = (parents.get(n) ?? []).filter(p => center.has(p)); return ps.length ? ps.reduce((s, p) => s + center.get(p)!, 0) / ps.length : Infinity; };
    row.sort((a, b) => key(a) - key(b) || a.localeCompare(b));
    let x = 20, rowH = 0;
    for (const n of row) {
      const b = boxes.get(n)!;
      b.x = x; b.y = y;
      center.set(n, x + b.w / 2);
      x += b.w + GAP_X;
      rowH = Math.max(rowH, b.h);
    }
    width = Math.max(width, x - GAP_X + 20);
    y += rowH + GAP_Y;
  }
  return { boxes: [...boxes.values()], width: Math.max(width, 200), height: Math.max(y - GAP_Y + 20, 100) };
}

/** Self-contained SVG; colors follow the VS Code theme inside a webview and fall back to black on white elsewhere. */
export function toSvg(m: UmlModel, detail: UmlDetail = 'members'): string {
  const { boxes, width, height } = layout(m, detail);
  const at = new Map(boxes.map(b => [b.cls.name, b]));
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Consolas, 'Courier New', monospace" font-size="12">`);
  out.push(`<style>
.box{fill:var(--vscode-editorWidget-background,#fff);stroke:var(--vscode-editor-foreground,#333);stroke-width:1}
.ext{stroke-dasharray:4 3;opacity:.8}
.itf{fill:var(--vscode-textBlockQuote-background,#f3f6ff)}
text{fill:var(--vscode-editor-foreground,#222)}
.name{font-weight:bold}.abs{font-style:italic}.stereo{opacity:.75;font-size:11px}
.edge{stroke:var(--vscode-editor-foreground,#333);fill:none;stroke-width:1}
.dash{stroke-dasharray:6 4}
.head{fill:var(--vscode-editor-background,#fff);stroke:var(--vscode-editor-foreground,#333)}
.dia{fill:var(--vscode-editor-foreground,#333)}
.lbl{font-size:11px;opacity:.8}
</style>`);
  out.push(`<defs>
<marker id="tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path class="head" d="M1,1 L11,6 L1,11 z"/></marker>
<marker id="dia" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="14" markerHeight="10" orient="auto-start-reverse"><path class="dia" d="M1,5 L7,1 L13,5 L7,9 z"/></marker>
</defs>`);
  for (const r of m.relations) {
    const a = at.get(r.from), b = at.get(r.to);
    if (!a || !b) continue;
    if (r.kind === 'composition') {
      // owner (diamond) → part, side to side when on one row
      const sameRow = Math.abs(a.y - b.y) < 1;
      const [x1, y1, x2, y2] = sameRow
        ? (a.x < b.x ? [a.x + a.w, a.y + 12, b.x, b.y + 12] : [a.x, a.y + 12, b.x + b.w, b.y + 12])
        : (a.y < b.y ? [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y] : [a.x + a.w / 2, a.y, b.x + b.w / 2, b.y + b.h]);
      out.push(`<line class="edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-start="url(#dia)"/>`);
      out.push(`<text class="lbl" x="${(x1 + x2) / 2 + (sameRow ? 0 : 6)}" y="${(y1 + y2) / 2 - 5}"${sameRow ? ' text-anchor="middle"' : ''}>${xmlEsc(r.label ?? '')}</text>`);
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2, y2 = b.y + b.h;
      const mid = (y1 + y2) / 2;
      out.push(`<path class="edge${r.kind === 'implements' ? ' dash' : ''}" d="M${x1},${y1} L${x1},${mid} L${x2},${mid} L${x2},${y2}" marker-end="url(#tri)"/>`);
    }
  }
  for (const b of boxes) {
    const c = b.cls;
    out.push(`<g data-class="${xmlEsc(c.name)}"${c.file ? ` data-file="${xmlEsc(c.file)}"` : ''}>`);
    out.push(`<rect class="box${c.kind === 'INTERFACE' ? ' itf' : ''}${c.external ? ' ext' : ''}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"/>`);
    let y = b.y + PAD;
    for (const l of b.lines) {
      if (l.kind === 'sep') { out.push(`<line class="edge" x1="${b.x}" y1="${y + 3}" x2="${b.x + b.w}" y2="${y + 3}"/>`); y += 6; continue; }
      const centered = l.kind === 'name' || l.kind === 'stereo';
      const cls = [l.kind === 'name' && 'name', l.kind === 'stereo' && 'stereo', l.abstract && 'abs'].filter(Boolean).join(' ');
      out.push(`<text${cls ? ` class="${cls}"` : ''} x="${centered ? b.x + b.w / 2 : b.x + PAD}" y="${y + 12}"${centered ? ' text-anchor="middle"' : ''}>${xmlEsc(l.text)}</text>`);
      y += LINE_H;
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

/** Short summary for the diagram title. */
export const describeModel = (m: UmlModel) => `${m.classes.length} classes, ${m.relations.length} relations`;

