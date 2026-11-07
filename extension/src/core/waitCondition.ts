// Condition grammar and type table for ads_wait: which literal compares with which PLC type, and how.

import type { Parsed } from './toolInput';
import type { WatchItem } from './adswatch';

export type Literal =
  | { kind: 'int'; value: bigint } | { kind: 'real'; value: number } | { kind: 'bool'; value: boolean }
  | { kind: 'name'; value: string } | { kind: 'string'; value: string };
export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type WaitCondition = { op: CompareOp; literal: Literal } | { op: 'changes' } | { op: 'contains'; text: string };
export type ValueClass = 'integer' | 'real' | 'bool' | 'enum' | 'string' | 'other';

export const MAX_CONDITION_LENGTH = 512;
const FORMS = 'condition must be one of: = v, <> v, < v, <= v, > v, >= v, changes, contains "text"';
const bad = (): Parsed<WaitCondition> => ({ ok: false, error: FORMS });

const INTEGER_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD']);
const unescape = (s: string): string => s.replace(/\\(["\\])/g, '$1');

function parseLiteral(s: string): Literal | undefined {
  const q = /^"((?:[^"\\]|\\.)*)"$/s.exec(s);
  if (q) return { kind: 'string', value: unescape(q[1]) };
  if (/^(true|false)$/i.test(s)) return { kind: 'bool', value: s.toLowerCase() === 'true' };
  if (/^-?\d+$/.test(s)) return { kind: 'int', value: BigInt(s) };
  if (/^-?\d+\.\d+(?:[eE][+-]?\d+)?$/.test(s)) {
    const value = Number(s);
    return Number.isFinite(value) ? { kind: 'real', value } : undefined;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { kind: 'name', value: s };
  return undefined;
}

export function parseCondition(text: string): Parsed<WaitCondition> {
  if (text.length > MAX_CONDITION_LENGTH) return { ok: false, error: `condition is longer than ${MAX_CONDITION_LENGTH} characters` };
  const s = text.trim();
  if (s === 'changes') return { ok: true, value: { op: 'changes' } };
  const c = /^contains\s+"((?:[^"\\]|\\.)*)"$/s.exec(s);
  if (c) return { ok: true, value: { op: 'contains', text: unescape(c[1]) } };
  const m = /^(<>|<=|>=|=|<|>)\s*(.*)$/s.exec(s);
  if (!m) return bad();
  const literal = parseLiteral(m[2]);
  return literal ? { ok: true, value: { op: m[1] as CompareOp, literal } } : bad();
}

export function classify(item: WatchItem, text: string | null, enumValue: number | null | undefined): ValueClass {
  if (enumValue !== null && enumValue !== undefined) return 'enum';
  const name = item.type.toUpperCase().replace(/\(.*$/, '').trim();
  if (INTEGER_TYPES.has(name)) return 'integer';
  if (name === 'REAL' || name === 'LREAL') return 'real';
  if (name === 'BOOL') return 'bool';
  if (name === 'STRING' || name === 'WSTRING') return 'string';
  // Unknown type name (an alias): decide by the value.
  if (text === 'TRUE' || text === 'FALSE') return 'bool';
  if (item.numeric && text !== null) {
    if (/^-?\d+$/.test(text)) return 'integer';
    if (text.trim() !== '' && Number.isFinite(Number(text))) return 'real';
  }
  return 'other';
}

const isOrder = (op: string): boolean => op === '<' || op === '<=' || op === '>' || op === '>=';

export function applicable(cond: WaitCondition, cls: ValueClass): string | undefined {
  if (cond.op === 'changes') return undefined;
  if (cond.op === 'contains') return cls === 'string' || cls === 'other' ? undefined : 'contains works on strings only';
  const { literal, op } = cond;
  switch (cls) {
    case 'bool':
      return literal.kind === 'bool' && !isOrder(op) ? undefined : 'BOOL allows only = TRUE / = FALSE and <>';
    case 'string':
      if (literal.kind !== 'string') return 'a STRING value needs a quoted string';
      return isOrder(op) ? 'a STRING value allows only = and <>' : undefined;
    case 'other':
      return literal.kind === 'string' && !isOrder(op) ? undefined : 'this type compares only as quoted text with = and <>';
    case 'integer':
      return literal.kind === 'int' ? undefined : 'an integer value needs an integer literal';
    case 'real':
      return literal.kind === 'int' || literal.kind === 'real' ? undefined : 'a REAL value needs a number';
    case 'enum':
      if (literal.kind === 'int') return undefined;
      if (literal.kind !== 'name') return 'an enum compares with a name or a number';
      return isOrder(op) ? 'an enum compares with < > only by number' : undefined;
  }
}

export function isValid(cls: ValueClass, text: string | null): boolean {
  if (text === null) return false;
  if (cls === 'real') return text.trim() !== '' && Number.isFinite(Number(text));
  return true;
}

function compare<T extends bigint | number | string | boolean>(op: CompareOp, a: T, b: T): boolean {
  switch (op) {
    case '=': return a === b;
    case '<>': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
}

export function meets(cond: WaitCondition, cls: ValueClass, text: string, enumValue: number | null | undefined, baseline: string | undefined): boolean {
  if (cond.op === 'changes') return baseline !== undefined && text !== baseline;
  if (cond.op === 'contains') return text.includes(cond.text);
  const { literal, op } = cond;
  switch (cls) {
    case 'integer': {
      if (literal.kind !== 'int') return false;
      let v: bigint;
      try { v = BigInt(text); } catch { return false; }
      return compare(op, v, literal.value);
    }
    case 'real':
      if (literal.kind !== 'int' && literal.kind !== 'real') return false;
      return compare(op, Number(text), Number(literal.value));
    case 'bool':
      return literal.kind === 'bool' && compare(op, text.toUpperCase() === 'TRUE', literal.value);
    case 'enum':
      if (literal.kind === 'name') return compare(op, text.toLowerCase(), literal.value.toLowerCase());
      if (literal.kind === 'int' && enumValue !== null && enumValue !== undefined) return compare(op, BigInt(enumValue), literal.value);
      return false;
    case 'string':
    case 'other':
      return literal.kind === 'string' && compare(op, text, literal.value);
  }
}

const quote = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;

export const conditionText = (cond: WaitCondition): string => {
  if (cond.op === 'changes') return 'changes';
  if (cond.op === 'contains') return `contains ${quote(cond.text)}`;
  const l = cond.literal;
  const v = l.kind === 'string' ? quote(l.value) : l.kind === 'bool' ? (l.value ? 'TRUE' : 'FALSE') : String(l.value);
  return `${cond.op} ${v}`;
};
