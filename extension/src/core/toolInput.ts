// Validation of ADS tool arguments that come from outside VS Code (MCP clients send untrusted JSON).

import { MAX_WATCHED } from './adswatch';
import { MAX_CONDITION_LENGTH, WaitCondition, parseCondition } from './waitCondition';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_SYMBOL_LENGTH = 512;
export const MAX_VALUE_LENGTH = 4096;

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** `undefined` (no arguments sent) counts as an empty object. */
function asObject(raw: unknown): Record<string, unknown> | string {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'arguments must be an object';
  return raw as Record<string, unknown>;
}

/** An optional string array; null or undefined counts as missing. */
function stringArray(o: Record<string, unknown>, field: string): string[] | string {
  const v = o[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return `${field} must be an array of strings`;
  if (v.length > MAX_WATCHED) return `${field} has more than ${MAX_WATCHED} entries`;
  if (v.some((x: string) => x.length > MAX_SYMBOL_LENGTH)) return `${field} has an entry longer than ${MAX_SYMBOL_LENGTH} characters`;
  return v as string[];
}

function str(o: Record<string, unknown>, field: string, max: number, required: boolean): string | undefined | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return required ? { error: `${field} must be a string` } : undefined;
  if (typeof v !== 'string') return { error: `${field} must be a string` };
  if (v.length > max) return { error: `${field} is longer than ${max} characters` };
  return v;
}

const isErr = (x: unknown): x is { error: string } => typeof x === 'object' && x !== null;

export function parseSymbolsInput(raw: unknown): Parsed<{ filter: string }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const filter = str(o, 'filter', MAX_SYMBOL_LENGTH, false);
  if (isErr(filter)) return fail(filter.error);
  return { ok: true, value: { filter: filter ?? '' } };
}

export function parseWatchInput(raw: unknown): Parsed<{ add: string[]; remove: string[] }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const add = stringArray(o, 'add');
  if (typeof add === 'string') return fail(add);
  const remove = stringArray(o, 'remove');
  if (typeof remove === 'string') return fail(remove);
  return { ok: true, value: { add, remove } };
}

export function parseReadInput(raw: unknown): Parsed<{ symbols: string[] }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  return { ok: true, value: { symbols } };
}

export function parseScopeInput(raw: unknown): Parsed<{ symbols: string[]; seconds?: number }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  const s = o.seconds;
  if (s === undefined || s === null) return { ok: true, value: { symbols } };
  if (typeof s !== 'number' || !Number.isFinite(s)) return fail('seconds must be a finite number');
  return { ok: true, value: { symbols, seconds: s } };
}

export function parseWriteInput(raw: unknown): Parsed<{ symbol: string; value: string }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbol = str(o, 'symbol', MAX_SYMBOL_LENGTH, true);
  if (isErr(symbol)) return fail(symbol.error);
  if (!symbol || !symbol.trim()) return fail('symbol must not be blank');
  const value = str(o, 'value', MAX_VALUE_LENGTH, true);
  if (isErr(value)) return fail(value.error);
  return { ok: true, value: { symbol, value: value ?? '' } };
}

export const WAIT_DEFAULT_SECONDS = 30;
export const WAIT_MAX_SECONDS = 120;

export function parseWaitInput(raw: unknown): Parsed<{ symbol: string; condition: WaitCondition; timeoutSeconds: number }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbol = str(o, 'symbol', MAX_SYMBOL_LENGTH, true);
  if (isErr(symbol)) return fail(symbol.error);
  if (!symbol || !symbol.trim()) return fail('symbol must not be blank');
  const text = str(o, 'condition', MAX_CONDITION_LENGTH, true);
  if (isErr(text)) return fail(text.error);
  const condition = parseCondition(text ?? '');
  if (!condition.ok) return fail(condition.error);
  const t = o.timeoutSeconds;
  let timeoutSeconds = WAIT_DEFAULT_SECONDS;
  if (t !== undefined && t !== null) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return fail('timeoutSeconds must be a finite number');
    timeoutSeconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, Math.round(t)));
  }
  return { ok: true, value: { symbol, condition: condition.value, timeoutSeconds } };
}
