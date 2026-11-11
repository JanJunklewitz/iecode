// Validation of ADS tool arguments that come from outside VS Code (MCP clients send untrusted JSON).

import { MAX_WATCHED } from './adswatch';
import { groupNameError } from './watchGroups';
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

/** An optional boolean; null or undefined counts as missing. */
function bool(o: Record<string, unknown>, field: string): boolean | undefined | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'boolean' ? v : { error: `${field} must be a boolean` };
}

export interface WatchRequest { add: string[]; remove: string[]; list?: boolean; clearAi?: boolean; force?: boolean; group?: string; enable?: boolean; removeGroup?: boolean }

/** The full list is returned for an empty call and for `list: true`. */
export const wantsFullList = (r: WatchRequest): boolean => r.list === true || (!r.add.length && !r.remove.length && !r.clearAi && r.group === undefined);

export function parseWatchInput(raw: unknown): Parsed<WatchRequest> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const add = stringArray(o, 'add');
  if (typeof add === 'string') return fail(add);
  const remove = stringArray(o, 'remove');
  if (typeof remove === 'string') return fail(remove);
  const flags: Partial<WatchRequest> = {};
  const group = str(o, 'group', MAX_SYMBOL_LENGTH, false);
  if (isErr(group)) return fail(group.error);
  if (group !== undefined) {
    const bad = groupNameError(group);
    if (bad) return fail(bad);
    flags.group = group.trim();
  }
  for (const field of ['list', 'force', 'clearAi', 'enable', 'removeGroup'] as const) {
    const v = bool(o, field);
    if (isErr(v)) return fail(v.error);
    if (v !== undefined) flags[field] = v;
  }
  if (flags.force && !remove.length) return fail('force needs remove');
  if (flags.enable !== undefined && flags.group === undefined) return fail('enable needs group');
  if (flags.removeGroup !== undefined && flags.group === undefined) return fail('removeGroup needs group');
  if (flags.enable !== undefined && flags.removeGroup) return fail('enable and removeGroup cannot be combined');
  if (flags.removeGroup && (add.length || remove.length)) return fail('removeGroup cannot be combined with add or remove');
  if (flags.group !== undefined && remove.length) return fail('group cannot be combined with remove; use removeGroup to remove a whole group');
  if (flags.clearAi && (add.length || remove.length || flags.group !== undefined)) {
    return fail(flags.group !== undefined ? 'clearAi cannot be combined with add, remove or group' : 'clearAi cannot be combined with add or remove');
  }
  if (flags.group !== undefined && !add.length && flags.enable === undefined && !flags.removeGroup) return fail('group needs add, enable or removeGroup');
  return { ok: true, value: { add, remove, ...flags } };
}

export function parseReadInput(raw: unknown): Parsed<{ symbols: string[] }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  return { ok: true, value: { symbols } };
}

export const SCOPE_MAX_ROWS = 200;

export interface ScopeArgs { symbols: string[]; seconds?: number; maxRows?: number; decimals?: number; changesOnly?: boolean; edges?: boolean }

/** An optional finite number, rounded and clamped; null or undefined counts as missing. */
function clampedNumber(o: Record<string, unknown>, field: string, min: number, max: number): number | undefined | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${field} must be a finite number` };
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function parseScopeInput(raw: unknown): Parsed<ScopeArgs> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  const value: ScopeArgs = { symbols };
  const s = o.seconds;
  if (s !== undefined && s !== null) {
    if (typeof s !== 'number' || !Number.isFinite(s)) return fail('seconds must be a finite number');
    value.seconds = s;
  }
  const maxRows = clampedNumber(o, 'maxRows', 1, SCOPE_MAX_ROWS);
  if (isErr(maxRows)) return fail(maxRows.error);
  if (maxRows !== undefined) value.maxRows = maxRows;
  const decimals = clampedNumber(o, 'decimals', 0, 9);
  if (isErr(decimals)) return fail(decimals.error);
  if (decimals !== undefined) value.decimals = decimals;
  const only = o.changesOnly;
  if (only !== undefined && only !== null) {
    if (typeof only !== 'boolean') return fail('changesOnly must be true or false');
    value.changesOnly = only;
  }
  const edges = o.edges;
  if (edges !== undefined && edges !== null) {
    if (typeof edges !== 'boolean') return fail('edges must be true or false');
    value.edges = edges;
  }
  if (value.edges && value.changesOnly) return fail('edges and changesOnly cannot be combined: edges lists BOOL edges, changesOnly lists every change');
  return { ok: true, value };
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
