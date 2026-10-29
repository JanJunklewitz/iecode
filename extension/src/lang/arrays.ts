// Checks ARRAY initializers in declarations: element count against the declared bounds, and the commas
// between elements (missing, doubled, trailing). Also records which array index each element initializes, for hover.

import { Token } from './lexer';
import type { Problem, Range } from './parser';

export interface ArrayElement {
  range: Range;
  /** Flat position of the element's first value (0-based); undefined after a repetition with unknown count. */
  pos?: number;
  /** Values the element stands for: n for n(value), 1 otherwise, undefined if n isn't a literal. */
  count?: number;
}

export interface ArrayInit {
  name: string;
  /** Text of the bounds, e.g. "0..273" or "1..2, 0..9". */
  bounds: string;
  /** Lower / upper bound per dimension, undefined if any bound isn't a numeric literal. */
  dims?: [number, number][];
  range: Range;
  elements: ArrayElement[];
}

const rangeOf = (t: Token): Range => ({ line: t.line, col: t.col, endLine: t.line, endCol: t.col + t.text.length });
const span = (a: Token, b: Token): Range => ({ line: a.line, col: a.col, endLine: b.line, endCol: b.col + b.text.length });
const CLOSE: Record<string, string> = { '[': ']', '(': ')' };
// functions whose call is one value, not a repetition count(value)
const CALL = /^(ADR|BITADR|SIZEOF|REF|ABS|SQRT|MIN|MAX|LIMIT|SEL|MUX|TRUNC|[A-Z]+_TO_[A-Z]+)$/;

function literal(toks: Token[]): number | undefined {
  let sign = 1, i = 0;
  if (toks[0]?.text === '-' || toks[0]?.text === '+') { sign = toks[0].text === '-' ? -1 : 1; i++; }
  if (toks.length !== i + 1 || toks[i].type !== 'number') return undefined;
  const m = /^(?:(?:[A-Za-z_]+#)?)(?:(2|8|16)#([0-9A-Fa-f_]+)|([0-9][0-9_]*))$/.exec(toks[i].text);
  if (!m) return undefined;
  const n = m[3] !== undefined ? parseInt(m[3].replace(/_/g, ''), 10) : parseInt(m[2].replace(/_/g, ''), Number(m[1]));
  return Number.isFinite(n) ? sign * n : undefined;
}

/** Bounds of the outermost ARRAY[...] of a type (tokens of the type expression). */
function parseBounds(type: Token[]): { text: string; dims?: [number, number][] } | undefined {
  if (type[0]?.upper !== 'ARRAY' || type[1]?.text !== '[') return undefined;
  const parts: Token[][] = [[]];
  let depth = 0, i = 2;
  for (; i < type.length; i++) {
    const t = type[i];
    if (t.text === '[' || t.text === '(') depth++;
    else if (t.text === ']' || t.text === ')') { if (depth-- === 0) break; }
    if (depth === 0 && t.text === ',') parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  if (i >= type.length) return undefined;
  const text = parts.map(p => p.map(t => t.text).join('')).join(', ');
  const dims: [number, number][] = [];
  for (const p of parts) {
    const dd = p.findIndex(t => t.text === '..');
    const lo = dd < 0 ? undefined : literal(p.slice(0, dd));
    const hi = dd < 0 ? undefined : literal(p.slice(dd + 1));
    if (lo === undefined || hi === undefined || hi < lo) return { text };
    dims.push([lo, hi]);
  }
  return { text, dims };
}

type Atom = { kind: 'value' | 'op'; first: Token; last: Token } | { kind: 'list'; first: Token; last: Token; open: string };

interface List { elements: Atom[][]; end: number }

/** Parses a [...] or (...) list starting at toks[i]; reports comma problems of it and of nested lists. */
function parseList(toks: Token[], i: number, problems: Problem[]): List | undefined {
  const open = toks[i];
  const close = CLOSE[open.text];
  const elements: Atom[][] = [[]];
  const commas: Token[] = [];
  for (let k = i + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.text === ';' || t.type === 'section' || t.upper === 'END_VAR' || t.upper === 'END_STRUCT') break;
    const cur = elements[elements.length - 1];
    if (t.text === close) {
      if (open.text === '[' || elements.length > 1) {
        // empty elements: [a,,b] / [,a] / [a,]
        elements.forEach((e, n) => {
          if (e.length) return;
          if (n === elements.length - 1 && n > 0) problems.push({ message: `Trailing ',' before '${close}'`, range: rangeOf(commas[n - 1]), severity: 'error' });
          else if (n > 0) problems.push({ message: `Double ','`, range: rangeOf(commas[n]), severity: 'error' });
          else if (elements.length > 1) problems.push({ message: `Missing element before ','`, range: rangeOf(commas[0]), severity: 'error' });
        });
      }
      return { elements: elements.length === 1 && !elements[0].length ? [] : elements, end: k };
    }
    if (t.text === ']' || t.text === ')') {
      problems.push({ message: `'${t.text}' closes '${open.text}' (line ${open.line + 1}), expected '${close}'`, range: rangeOf(t), severity: 'error' });
      return undefined;
    }
    if (t.text === ',') { commas.push(t); elements.push([]); continue; }
    let atom: Atom;
    if (t.text === '[' || t.text === '(') {
      const inner = parseList(toks, k, problems);
      if (!inner) return undefined;
      atom = { kind: 'list', first: t, last: toks[inner.end], open: t.text };
      k = inner.end;
    } else {
      atom = { kind: t.type === 'ident' || t.type === 'number' || t.type === 'string' || t.upper === 'TRUE' || t.upper === 'FALSE' ? 'value' : 'op', first: t, last: t };
    }
    const prev = cur[cur.length - 1];
    if (prev && prev.kind !== 'op' && missingComma(prev, atom, cur.length === 1))
      problems.push({ message: `Missing ',' before '${atom.first.text}'`, range: rangeOf(atom.first), severity: 'error' });
    cur.push(atom);
  }
  problems.push({ message: `'${open.text}' without '${close}'`, range: rangeOf(open), severity: 'error' });
  return undefined;
}

/** Two atoms side by side that need a ',' between them: `a b`, `(..) (..)`, `[..] [..]`, `'x' 5`. */
function missingComma(prev: Atom, next: Atom, prevIsFirst: boolean): boolean {
  if (next.kind === 'value') return true;
  if (next.kind !== 'list') return false;
  if (prev.kind === 'value') return false;           // f(x), a[1], 3(7)
  // list after list: (a:=1) (a:=2), [1,2] [3,4] — but x[1][2] indexes on
  return !(next.open === '[' && prev.kind === 'list' && prev.open === '[' && !prevIsFirst);
}

/**
 * Checks the initializer of `name : ARRAY[..] OF T := [ ... ]`.
 * `type`: tokens of the type expression; `init`: index of the '[' after ':='.
 */
export function checkArrayInit(name: Token, type: Token[], toks: Token[], init: number, problems: Problem[]): ArrayInit | undefined {
  const bounds = parseBounds(type);
  if (!bounds || toks[init]?.text !== '[') return undefined;
  const list = parseList(toks, init, problems);
  if (!list) return undefined;
  const elements: ArrayElement[] = [];
  let pos: number | undefined = 0, nested = false;
  for (const e of list.elements) {
    if (!e.length) continue;
    let count: number | undefined = 1;
    // n(value) repeats value n times; NAME(value) is a constant count or a call
    if (e.length === 2 && e[1].kind === 'list' && e[1].open === '(') {
      if (e[0].first.type === 'number') count = literal([e[0].first]);
      else if (e[0].first.type === 'ident' && !CALL.test(e[0].first.upper)) count = undefined;
    }
    if (e.length === 1 && e[0].kind === 'list' && e[0].open === '[') nested = true;
    elements.push({ range: span(e[0].first, e[e.length - 1].last), pos, count });
    pos = pos === undefined || count === undefined ? undefined : pos + count;
  }
  const dims = bounds.dims;
  const result: ArrayInit = { name: name.text, bounds: bounds.text, dims, range: span(toks[init], toks[list.end]), elements };
  // multi-dimensional arrays with nested [...] rows: their layout isn't checked
  if (dims && pos !== undefined && elements.length && !(nested && dims.length > 1)) {
    const size = dims.reduce((n, [lo, hi]) => n * (hi - lo + 1), 1);
    if (pos !== size)
      problems.push({
        message: `ARRAY[${bounds.text}] has ${size} element${size === 1 ? '' : 's'}, initializer has ${pos}`,
        range: rangeOf(name),
        severity: pos > size ? 'error' : 'warning',
      });
  }
  return result;
}

/** Index text of the flat position n, e.g. "[17]" or "[1, 3]". */
export function indexText(a: ArrayInit, n: number): string {
  if (!a.dims) return `#${n + 1}`;
  const idx: number[] = [];
  for (let d = a.dims.length - 1; d >= 0; d--) {
    const [lo, hi] = a.dims[d];
    const len = hi - lo + 1;
    idx.unshift(lo + (n % len));
    n = Math.floor(n / len);
  }
  return `[${idx.join(', ')}]`;
}

/** Hover text for the element of an array initializer at a position, e.g. "aDevices[17]". */
export function elementAt(arrays: ArrayInit[], line: number, col: number): string | undefined {
  const inside = (r: Range) => (line > r.line || (line === r.line && col >= r.col)) && (line < r.endLine || (line === r.endLine && col <= r.endCol));
  for (const a of arrays) {
    if (!inside(a.range)) continue;
    const e = a.elements.find(x => inside(x.range));
    if (!e) return undefined;
    const size = a.dims?.reduce((n, [lo, hi]) => n * (hi - lo + 1), 1);
    const of = size !== undefined ? ` of ${size}` : '';
    if (e.pos === undefined) return `${a.name}: element ${a.elements.indexOf(e) + 1} (index unknown after a repetition)`;
    if (e.count === undefined) return `${a.name}${indexText(a, e.pos)}… (repetition, count unknown)`;
    if (e.count === 1) return `${a.name}${indexText(a, e.pos)} — element ${e.pos + 1}${of}`;
    return `${a.name}${indexText(a, e.pos)} … ${a.name}${indexText(a, e.pos + e.count - 1)} — elements ${e.pos + 1}–${e.pos + e.count}${of}`;
  }
  return undefined;
}
