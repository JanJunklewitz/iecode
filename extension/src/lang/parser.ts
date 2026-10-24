// Parses the declarations of one object (in the IECode view format) into symbols:
// the object, its members (methods, properties, actions), variables with types, enum values, struct fields.
// Implementation code is only scanned for block structure (IF / END_IF …) to report obvious errors.

import { Token, tokenize } from './lexer';
import { HEADER_RE } from '../model';

export type SymbolKind =
  | 'FUNCTION_BLOCK' | 'PROGRAM' | 'FUNCTION' | 'INTERFACE' | 'STRUCT' | 'UNION' | 'ENUM' | 'ALIAS' | 'GVL'
  | 'METHOD' | 'PROPERTY' | 'ACTION' | 'TRANSITION' | 'VARIABLE' | 'ENUM_VALUE' | 'FIELD';

export interface Range { line: number; col: number; endLine: number; endCol: number }

export interface PlcSymbol {
  name: string;
  kind: SymbolKind;
  /** Declared type (variables, fields, properties, function / method return type, alias base). */
  type?: string;
  /** VAR_INPUT, VAR_OUTPUT, VAR, VAR_GLOBAL … for variables. */
  scope?: string;
  extends?: string[];
  implements?: string[];
  /** Access modifier of members. */
  access?: string;
  /** Range of the name. */
  range: Range;
  /** Whole section (members) or declaration line (variables). */
  full: Range;
  /** Text of the declaration line, for hover. */
  detail: string;
  children: PlcSymbol[];
}

export interface Problem { message: string; range: Range; severity: 'error' | 'warning' }

export interface ParsedObject { root?: PlcSymbol; problems: Problem[] }

const VAR_BLOCKS = new Set(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_STAT', 'VAR_INST', 'VAR_EXTERNAL', 'VAR_CONFIG']);
const POU_KINDS = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE']);
const ACCESS = new Set(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL']);

const rangeOf = (t: Token): Range => ({ line: t.line, col: t.col, endLine: t.line, endCol: t.col + t.text.length });

interface Section { kind: string; name: string; start: number; end: number; headerLine: number; implLine: number }

/** Splits the view into sections by its //==== headers (line numbers are of the whole view). */
export function sections(view: string): Section[] {
  const lines = view.split('\n');
  const out: Section[] = [{ kind: 'MAIN', name: '', start: 0, end: lines.length, headerLine: -1, implLine: -1 }];
  lines.forEach((l, i) => {
    const m = HEADER_RE.exec(l);
    if (!m) return;
    out[out.length - 1].end = i;
    out.push({ kind: m[1], name: m[2], start: i + 1, end: lines.length, headerLine: i, implLine: -1 });
  });
  for (const s of out)
    for (let i = s.start; i < s.end; i++) if (/^\/\/---- IMPLEMENTATION/.test(lines[i])) { s.implLine = i; break; }
  return out;
}

/** Parses the type expression starting at tokens[i] up to ':=' / ';' / ')' — returns text and next index. */
function parseType(toks: Token[], i: number): [string, number] {
  let depth = 0;
  const parts: string[] = [];
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (depth === 0 && (t.text === ':=' || t.text === ';' || t.text === ')' || t.type === 'section')) break;
    if (t.text === '(' || t.text === '[') depth++;
    if (t.text === ')' || t.text === ']') depth--;
    parts.push(t.text);
  }
  return [parts.join(' ').replace(/\s*([[\](),.])\s*/g, '$1').replace(/\bOF\b/g, ' OF ').replace(/\bTO\b/g, ' TO ').replace(/\s+/g, ' ').trim(), i];
}

/** Variables of all VAR … END_VAR blocks in a token range. */
function parseVarBlocks(toks: Token[], lines: string[], problems: Problem[]): PlcSymbol[] {
  const vars: PlcSymbol[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!(toks[i].type === 'keyword' && VAR_BLOCKS.has(toks[i].upper))) continue;
    const scope = toks[i].upper;
    const open = toks[i];
    i++;
    while (i < toks.length && toks[i].type === 'keyword' && ['CONSTANT', 'RETAIN', 'PERSISTENT'].includes(toks[i].upper)) i++;
    let closed = false;
    while (i < toks.length) {
      const t = toks[i];
      if (t.upper === 'END_VAR') { closed = true; break; }
      if (t.type === 'section' || (t.type === 'keyword' && VAR_BLOCKS.has(t.upper))) break;
      if (t.type === 'ident') {
        // a, b, c : TYPE := init;
        const names: Token[] = [t];
        let k = i + 1;
        while (toks[k]?.text === ',' && toks[k + 1]?.type === 'ident') { names.push(toks[k + 1]); k += 2; }
        if (toks[k]?.type === 'keyword' && toks[k].upper === 'AT') { k++; while (k < toks.length && toks[k].text !== ':') k++; }
        if (toks[k]?.text === ':') {
          const [type, next] = parseType(toks, k + 1);
          for (const n of names)
            vars.push({ name: n.text, kind: 'VARIABLE', type, scope, range: rangeOf(n), full: rangeOf(n), detail: lines[n.line]?.trim() ?? '', children: [] });
          k = next;
          let depth = 0;
          while (k < toks.length && !(depth === 0 && toks[k].text === ';')) {
            if (toks[k].upper === 'END_VAR' || toks[k].type === 'section') break;
            if (toks[k].text === '(' || toks[k].text === '[') depth++;
            if (toks[k].text === ')' || toks[k].text === ']') depth--;
            k++;
          }
          i = toks[k]?.text === ';' ? k + 1 : k;
          continue;
        }
      }
      i++;
    }
    if (!closed) problems.push({ message: `${scope} without END_VAR`, range: rangeOf(open), severity: 'error' });
  }
  const seen = new Map<string, PlcSymbol>();
  for (const v of vars) {
    const k = v.name.toUpperCase();
    if (seen.has(k)) problems.push({ message: `Duplicate variable '${v.name}'`, range: v.range, severity: 'error' });
    else seen.set(k, v);
  }
  return vars;
}

const BLOCKS: [string, string][] = [['IF', 'END_IF'], ['CASE', 'END_CASE'], ['FOR', 'END_FOR'], ['WHILE', 'END_WHILE'], ['REPEAT', 'END_REPEAT']];
const OPENERS = new Map(BLOCKS);
const CLOSERS = new Map(BLOCKS.map(([o, c]) => [c, o]));

/** Checks that IF / CASE / FOR / WHILE / REPEAT blocks are closed in implementation code. */
export function checkBlocks(toks: Token[]): Problem[] {
  const problems: Problem[] = [];
  const stack: Token[] = [];
  for (const t of toks) {
    if (t.type !== 'keyword') continue;
    if (OPENERS.has(t.upper)) stack.push(t);
    else if (CLOSERS.has(t.upper)) {
      const want = CLOSERS.get(t.upper)!;
      const top = stack[stack.length - 1];
      if (top?.upper === want) stack.pop();
      else problems.push({ message: top ? `${t.upper} closes ${top.upper} (line ${top.line + 1})` : `${t.upper} without ${want}`, range: rangeOf(t), severity: 'error' });
    }
  }
  for (const t of stack) problems.push({ message: `${t.upper} without ${OPENERS.get(t.upper)}`, range: rangeOf(t), severity: 'error' });
  return problems;
}

/** Parses one object view (or a .TcGVL / .TcDUT view without sections). */
export function parseObject(view: string, fallbackName: string): ParsedObject {
  const lines = view.split('\n');
  const problems: Problem[] = [];
  const secs = sections(view);
  const toksOf = (from: number, to: number) => {
    const text = lines.slice(from, to).join('\n');
    return tokenize(text).map(t => ({ ...t, line: t.line + from }));
  };

  const main = secs[0];
  const declEnd = main.implLine >= 0 ? main.implLine : main.end;
  const mainToks = toksOf(main.start, declEnd);
  const root = parseHeader(mainToks, lines, fallbackName, main, secs[1]?.headerLine ?? lines.length);
  if (root) root.children.push(...parseVarBlocks(mainToks, lines, problems));
  if (main.implLine >= 0) problems.push(...checkBlocks(toksOf(main.implLine + 1, main.end)));

  if (root) {
    // TYPE … STRUCT fields / enum values
    if (root.kind === 'STRUCT' || root.kind === 'UNION') root.children.push(...parseFields(mainToks, lines, problems));
    if (root.kind === 'ENUM') root.children.push(...parseEnum(mainToks, lines));
  }

  let property: PlcSymbol | undefined;
  for (const s of secs.slice(1)) {
    const declTo = s.implLine >= 0 ? s.implLine : s.end;
    const toks = toksOf(s.start, declTo);
    const fullRange: Range = { line: s.headerLine, col: 0, endLine: Math.max(s.end - 1, s.headerLine), endCol: lines[Math.max(s.end - 1, s.headerLine)]?.length ?? 0 };
    if (s.implLine >= 0) problems.push(...checkBlocks(toksOf(s.implLine + 1, s.end)));
    if (s.kind === 'GET' || s.kind === 'SET') {
      // accessors belong to the property declared before them
      if (property && property.name.toUpperCase() === s.name.toUpperCase()) {
        property.full = { ...property.full, endLine: fullRange.endLine, endCol: fullRange.endCol };
        property.children.push(...parseVarBlocks(toks, lines, problems).map(v => ({ ...v, scope: `${s.kind} ${v.scope}` })));
      }
      continue;
    }
    const head = toks.find(t => t.type === 'keyword' && ['METHOD', 'PROPERTY', 'ACTION', 'TRANSITION'].includes(t.upper));
    const nameTok = head ? toks[toks.indexOf(head) + 1 + toks.slice(toks.indexOf(head) + 1).findIndex(t => t.type === 'ident')] : undefined;
    let access: string | undefined;
    if (head) for (const t of toks.slice(toks.indexOf(head) + 1)) { if (ACCESS.has(t.upper)) access = t.upper; if (t.type === 'ident') break; }
    let type: string | undefined;
    if (nameTok) {
      // return / property type: the rest of the header line after ':'
      const after = toks.indexOf(nameTok) + 1;
      if (toks[after]?.text === ':')
        type = toks.slice(after + 1).filter(t => t.line === nameTok.line).map(t => t.text).join(' ').replace(/\s*([[\](),.])\s*/g, '$1').trim() || undefined;
    }
    const sym: PlcSymbol = {
      name: s.name, kind: s.kind as SymbolKind, type, access,
      range: nameTok ? rangeOf(nameTok) : { line: s.headerLine, col: 0, endLine: s.headerLine, endCol: 0 },
      full: fullRange,
      detail: head ? lines[head.line].trim() : `${s.kind} ${s.name}`,
      children: parseVarBlocks(toks, lines, problems),
    };
    if (s.kind === 'PROPERTY') property = sym;
    root?.children.push(sym);
  }
  return { root, problems };
}

function parseHeader(toks: Token[], lines: string[], fallbackName: string, main: Section, endLine: number): PlcSymbol | undefined {
  const full: Range = { line: 0, col: 0, endLine: Math.max(endLine - 1, 0), endCol: 0 };
  const head = toks.find(t => t.type === 'keyword' && (POU_KINDS.has(t.upper) || t.upper === 'TYPE' || t.upper === 'VAR_GLOBAL'));
  if (!head) return undefined;
  const at = toks.indexOf(head);
  if (head.upper === 'VAR_GLOBAL')
    return { name: fallbackName, kind: 'GVL', range: rangeOf(head), full, detail: 'VAR_GLOBAL', children: [] };
  const nameTok = toks.slice(at + 1).find(t => t.type === 'ident');
  if (!nameTok) return undefined;
  const sym: PlcSymbol = { name: nameTok.text, kind: head.upper as SymbolKind, range: rangeOf(nameTok), full, detail: lines[head.line].trim(), children: [] };
  const rest = toks.slice(toks.indexOf(nameTok) + 1);
  const list = (kw: string) => {
    const k = rest.findIndex(t => t.upper === kw);
    if (k < 0) return undefined;
    const names: string[] = [];
    for (let j = k + 1; j < rest.length; j++) {
      const t = rest[j];
      if (t.type === 'ident') {
        let n = t.text;
        while (rest[j + 1]?.text === '.' && rest[j + 2]?.type === 'ident') { n += '.' + rest[j + 2].text; j += 2; }
        names.push(n);
      } else if (t.text !== ',') break;
    }
    return names;
  };
  sym.extends = list('EXTENDS');
  sym.implements = list('IMPLEMENTS');
  if (head.upper === 'FUNCTION' && rest[0]?.text === ':') sym.type = rest[1]?.text;
  if (head.upper === 'TYPE') {
    const colon = rest.findIndex(t => t.text === ':');
    const next = rest[colon + 1];
    if (next?.upper === 'STRUCT') sym.kind = 'STRUCT';
    else if (next?.upper === 'UNION') sym.kind = 'UNION';
    else if (next?.text === '(') sym.kind = 'ENUM';
    else { sym.kind = 'ALIAS'; sym.type = parseType(rest, colon + 1)[0]; }
    if (sym.kind === 'STRUCT' && rest[colon + 2]?.upper === 'EXTENDS') sym.extends = [rest[colon + 3]?.text].filter(Boolean);
  }
  return sym;
}

function parseFields(toks: Token[], lines: string[], problems: Problem[]): PlcSymbol[] {
  const s = toks.findIndex(t => t.upper === 'STRUCT' || t.upper === 'UNION');
  const e = toks.findIndex(t => t.upper === 'END_STRUCT' || t.upper === 'END_UNION');
  if (s < 0) return [];
  // reuse the VAR parser on the field list
  const inner = toks.slice(s + 1, e < 0 ? toks.length : e);
  if (inner.length && inner[0].type === 'keyword' && inner[0].upper === 'EXTENDS') inner.splice(0, 2);
  const fake: Token = { ...toks[s], type: 'keyword', text: 'VAR', upper: 'VAR' };
  const end: Token = { ...toks[e < 0 ? toks.length - 1 : e], type: 'keyword', text: 'END_VAR', upper: 'END_VAR' };
  return parseVarBlocks([fake, ...inner, end], lines, problems).map(v => ({ ...v, kind: 'FIELD' as const, scope: undefined }));
}

function parseEnum(toks: Token[], lines: string[]): PlcSymbol[] {
  const open = toks.findIndex(t => t.text === '(');
  const out: PlcSymbol[] = [];
  let depth = 0;
  for (let i = open; i < toks.length && i >= 0; i++) {
    const t = toks[i];
    if (t.text === '(') depth++;
    else if (t.text === ')') { if (--depth === 0) break; }
    else if (depth === 1 && t.type === 'ident' && (toks[i - 1].text === '(' || toks[i - 1].text === ','))
      out.push({ name: t.text, kind: 'ENUM_VALUE', range: rangeOf(t), full: rangeOf(t), detail: lines[t.line].trim(), children: [] });
  }
  return out;
}
