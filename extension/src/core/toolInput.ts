// Validation of ADS tool arguments that come from outside VS Code (MCP clients send untrusted JSON).

import { MAX_WATCHED } from './adswatch';
import { groupNameError } from './watchGroups';
import type { SourceChoice } from './symbolSource';
import { MAX_PULSE_MS, MIN_PULSE_MS, WriteItem, oppositeBool } from './writeText';
import { CAPTURE_DEFAULT_POST, CAPTURE_DEFAULT_PRE, CAPTURE_MAX_POST, CAPTURE_MAX_PRE, CaptureRequest } from './captureRun';
import { DEFAULT_LOG_LINES, LogMarker, MAX_LOG_LINES, decodeMarker } from './logRead';
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

export interface SymbolsRequest { filter: string; source?: SourceChoice; enumType?: string; hidden?: boolean; prefix?: string; type?: string; offset?: number; limit?: number }

export function parseSymbolsInput(raw: unknown): Parsed<SymbolsRequest> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const filter = str(o, 'filter', MAX_SYMBOL_LENGTH, false);
  if (isErr(filter)) return fail(filter.error);
  const enumType = str(o, 'enumType', MAX_SYMBOL_LENGTH, false);
  if (isErr(enumType)) return fail(enumType.error);
  const hidden = o.hidden;
  if (hidden !== undefined && hidden !== null && typeof hidden !== 'boolean') return fail('hidden must be true or false');
  const prefix = str(o, 'prefix', MAX_SYMBOL_LENGTH, false);
  if (isErr(prefix)) return fail(prefix.error);
  const type = str(o, 'type', MAX_SYMBOL_LENGTH, false);
  if (isErr(type)) return fail(type.error);
  const offset = o.offset;
  if (offset !== undefined && offset !== null && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) return fail('offset must be a whole number of 0 or more');
  const limit = o.limit;
  if (limit !== undefined && limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) return fail('limit must be a whole number from 1 to 100');
  const source = str(o, 'source', 16, false);
  if (isErr(source)) return fail(source.error);
  if (source !== undefined && !['auto', 'online', 'build', 'source'].includes(source)) return fail('source must be one of auto, online, build, source');
  const value: SymbolsRequest = { filter: filter ?? '' };
  if (source && source !== 'auto') value.source = source as SourceChoice;
  if (prefix?.trim()) value.prefix = prefix.trim();
  if (type?.trim()) value.type = type.trim();
  if (typeof offset === 'number') value.offset = offset;
  if (typeof limit === 'number') value.limit = limit;
  if (enumType?.trim()) value.enumType = enumType.trim();
  if (typeof hidden === 'boolean') value.hidden = hidden;
  return { ok: true, value };
}

/** An optional boolean; null or undefined counts as missing. */
function bool(o: Record<string, unknown>, field: string): boolean | undefined | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'boolean' ? v : { error: `${field} must be a boolean` };
}

export interface WatchRequest { add: string[]; remove: string[]; list?: boolean; clearAi?: boolean; force?: boolean; group?: string; enable?: boolean; removeGroup?: boolean; expand?: boolean }

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
  for (const field of ['list', 'force', 'clearAi', 'enable', 'removeGroup', 'expand'] as const) {
    const v = bool(o, field);
    if (isErr(v)) return fail(v.error);
    if (v !== undefined) flags[field] = v;
  }
  if (flags.force && !remove.length) return fail('force needs remove');
  if (flags.group !== undefined && flags.list) return fail('list cannot be combined with group');
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

export function parseReadInput(raw: unknown): Parsed<{ symbols: string[]; depth?: number }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  const depth = o.depth;
  if (depth === undefined || depth === null) return { ok: true, value: { symbols } };
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 5) return fail('depth must be a whole number from 1 to 5');
  return { ok: true, value: { symbols, depth } };
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

export const MAX_WRITES = 20;
/** The key a prepared Copilot confirmation is stored under: the single write as before, a batch as a whole. */
export function writeKey(input: WriteInput): string {
  const persistent = 'confirmPersistent' in input && input.confirmPersistent ? [true] : [];
  if ('journal' in input) return JSON.stringify(['journal']);
  if ('restore' in input) return JSON.stringify(['restore', ...persistent]);
  return 'writes' in input
    ? JSON.stringify(['batch', input.writes.map(w => (w.pulseMs === undefined ? [w.symbol, w.value] : [w.symbol, w.value, w.pulseMs])), ...persistent])
    : JSON.stringify([input.symbol, input.value, ...(input.pulseMs === undefined ? [] : [input.pulseMs]), ...persistent]);
}

/** A write call: one symbol, or a batch. `confirmPersistent` says the user asked for a write to PERSISTENT data. */
export type WriteCall = { symbol: string; value: string; pulseMs?: number; confirmPersistent?: true } | { writes: WriteItem[]; confirmPersistent?: true };
export type WriteInput = WriteCall | { journal: true } | { restore: true; confirmPersistent?: true };

/** `pulseMs` of one write: undefined when absent, an error text when it is not a whole number in range or the value is no BOOL. */
function parsePulse(o: Record<string, unknown>, value: string, where: string): number | undefined | { error: string } {
  const v = o.pulseMs;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_PULSE_MS || v > MAX_PULSE_MS) return { error: `${where}pulseMs must be a whole number from ${MIN_PULSE_MS} to ${MAX_PULSE_MS}` };
  if (oppositeBool(value) === undefined) return { error: `${where}pulseMs needs a BOOL value (TRUE, FALSE, 1 or 0), not ${JSON.stringify(value)}` };
  return v;
}

/** One { symbol, value } pair; `where` prefixes the error ("" for the single form, "writes[1]." in a batch). */
function parseWriteItem(raw: unknown, where: string, shape: string): Parsed<WriteItem> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(shape);
  const o = raw as Record<string, unknown>;
  const symbol = str(o, 'symbol', MAX_SYMBOL_LENGTH, true);
  if (isErr(symbol)) return fail(where + symbol.error);
  if (!symbol || !symbol.trim()) return fail(where + 'symbol must not be blank');
  const value = str(o, 'value', MAX_VALUE_LENGTH, true);
  if (isErr(value)) return fail(where + value.error);
  const pulseMs = parsePulse(o, value ?? '', where);
  if (isErr(pulseMs)) return fail(pulseMs.error);
  return { ok: true, value: pulseMs === undefined ? { symbol, value: value ?? '' } : { symbol, value: value ?? '', pulseMs } };
}

/** `journal` and `restore` are flags that make a call of their own: true, or absent (false counts as absent). */
function flag(o: Record<string, unknown>, field: string): boolean | { error: string } {
  const v = o[field];
  if (v === undefined || v === null || v === false) return false;
  return v === true ? true : { error: `${field} must be true or false` };
}

export function parseWriteInput(raw: unknown): Parsed<WriteInput> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const journal = flag(o, 'journal');
  if (isErr(journal)) return fail(journal.error);
  const restore = flag(o, 'restore');
  if (isErr(restore)) return fail(restore.error);
  const confirm = flag(o, 'confirmPersistent');
  if (isErr(confirm)) return fail(confirm.error);
  const persistent = confirm ? { confirmPersistent: true as const } : {};
  const hasWrites = o.writes !== undefined && o.writes !== null;
  const hasPair = o.symbol !== undefined || o.value !== undefined;
  if (journal || restore) {
    if (hasWrites || hasPair || (journal && restore)) return fail('use either symbol and value, writes, journal or restore');
    if (journal) return confirm ? fail('journal does not take confirmPersistent') : { ok: true, value: { journal: true } };
    return { ok: true, value: { restore: true, ...persistent } };
  }
  if (hasWrites) {
    if (hasPair) return fail('use either symbol and value or writes, not both');
    const list = o.writes;
    const shape = 'writes must be an array of { symbol, value } objects';
    if (!Array.isArray(list)) return fail(shape);
    if (!list.length) return fail('writes must not be empty');
    if (list.length > MAX_WRITES) return fail(`writes has more than ${MAX_WRITES} entries`);
    const writes: WriteItem[] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < list.length; i++) {
      const p = parseWriteItem(list[i], `writes[${i}].`, shape);
      if (!p.ok) return p;
      const key = p.value.symbol.trim().toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) return fail(`writes[${i}] repeats writes[${first}]: ${writes[first].symbol.trim()}`);
      seen.set(key, i);
      writes.push(p.value);
    }
    if (writes.filter(w => w.pulseMs !== undefined).length > 1) return fail('only one write per call can set pulseMs');
    return { ok: true, value: { writes, ...persistent } };
  }
  const symbol = str(o, 'symbol', MAX_SYMBOL_LENGTH, true);
  if (isErr(symbol)) return fail(symbol.error);
  if (!symbol || !symbol.trim()) return fail('symbol must not be blank');
  const value = str(o, 'value', MAX_VALUE_LENGTH, true);
  if (isErr(value)) return fail(value.error);
  const pulseMs = parsePulse(o, value ?? '', '');
  if (isErr(pulseMs)) return fail(pulseMs.error);
  return { ok: true, value: { symbol, value: value ?? '', ...(pulseMs === undefined ? {} : { pulseMs }), ...persistent } };
}

/** A finite number rounded to a whole number; clamping and its note belong to planConfig. */
function wholeNumber(o: Record<string, unknown>, field: string): number | undefined | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${field} must be a finite number` };
  return Math.round(v);
}

export function parseConfigInput(raw: unknown): Parsed<{ pollMs?: number; bufferSeconds?: number }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const pollMs = wholeNumber(o, 'pollMs');
  if (isErr(pollMs)) return fail(pollMs.error);
  const bufferSeconds = wholeNumber(o, 'bufferSeconds');
  if (isErr(bufferSeconds)) return fail(bufferSeconds.error);
  const value: { pollMs?: number; bufferSeconds?: number } = {};
  if (pollMs !== undefined) value.pollMs = pollMs;
  if (bufferSeconds !== undefined) value.bufferSeconds = bufferSeconds;
  return { ok: true, value };
}

export function parsePresetInput(raw: unknown): Parsed<{ path?: string; preset?: string }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const path = str(o, 'path', MAX_SYMBOL_LENGTH, false);
  if (isErr(path)) return fail(path.error);
  const preset = str(o, 'preset', MAX_SYMBOL_LENGTH, false);
  if (isErr(preset)) return fail(preset.error);
  if (path !== undefined && !path.trim()) return fail('path must not be blank');
  if (preset !== undefined && !preset.trim()) return fail('preset must not be blank');
  if (preset !== undefined && path === undefined) return fail('path is required with preset');
  const value: { path?: string; preset?: string } = {};
  if (path !== undefined) value.path = path.trim();
  if (preset !== undefined) value.preset = preset.trim();
  return { ok: true, value };
}

/** A whole number of seconds within [min, max]; a missing value gives the default. */
function boundedSeconds(o: Record<string, unknown>, field: string, min: number, max: number, dflt: number): number | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${field} must be a finite number` };
  return Math.min(max, Math.max(min, Math.round(v)));
}

export interface LogRequest { mark?: boolean; since?: LogMarker; filter: string[]; exclude: string[]; maxLines: number }
export const MAX_LOG_TERMS = 10;
export const MAX_LOG_TERM_LENGTH = 100;

function logTerms(o: Record<string, unknown>, field: 'filter' | 'exclude'): string[] | { error: string } {
  const v = o[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return { error: `${field} must be a list of strings` };
  if (v.length > MAX_LOG_TERMS) return { error: `${field} may have at most ${MAX_LOG_TERMS} entries` };
  const terms = (v as string[]).map(x => x.trim());
  if (terms.some(x => x.length < 1 || x.length > MAX_LOG_TERM_LENGTH)) return { error: `${field} entries must be 1 to ${MAX_LOG_TERM_LENGTH} characters` };
  return terms;
}

export function parseLogInput(raw: unknown): Parsed<LogRequest> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  if (o.mark !== undefined && o.mark !== null && typeof o.mark !== 'boolean') return fail('mark must be true or false');
  if (o.since !== undefined && o.since !== null && typeof o.since !== 'string') return fail('since must be a string');
  const filter = logTerms(o, 'filter');
  if (!Array.isArray(filter)) return fail(filter.error);
  const exclude = logTerms(o, 'exclude');
  if (!Array.isArray(exclude)) return fail(exclude.error);
  const given = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  if (o.mark === true) {
    if (given('since') || given('filter') || given('exclude') || given('maxLines')) return fail('mark cannot be combined with since, filter, exclude or maxLines');
    return { ok: true, value: { mark: true, filter: [], exclude: [], maxLines: DEFAULT_LOG_LINES } };
  }
  let since: LogMarker | undefined;
  if (typeof o.since === 'string') {
    since = decodeMarker(o.since);
    if (!since) return fail('since is not a marker from ads_log');
  }
  let maxLines = DEFAULT_LOG_LINES;
  if (given('maxLines')) {
    const m = o.maxLines;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MAX_LOG_LINES) return fail(`maxLines must be an integer from 1 to ${MAX_LOG_LINES}`);
    maxLines = m;
  }
  const value: LogRequest = { filter, exclude, maxLines };
  if (since) value.since = since;
  return { ok: true, value };
}

export function parseCaptureInput(raw: unknown): Parsed<CaptureRequest & { symbols: string[] }> {
  const o = asObject(raw);
  if (typeof o === 'string') return fail(o);
  const wait = parseWaitInput({ symbol: o.symbol, condition: o.condition, timeoutSeconds: o.timeoutSeconds });
  if (!wait.ok) return wait;
  const pre = boundedSeconds(o, 'preSeconds', 0, CAPTURE_MAX_PRE, CAPTURE_DEFAULT_PRE);
  if (typeof pre !== 'number') return fail(pre.error);
  const post = boundedSeconds(o, 'postSeconds', 0, CAPTURE_MAX_POST, CAPTURE_DEFAULT_POST);
  if (typeof post !== 'number') return fail(post.error);
  const symbols = stringArray(o, 'symbols');
  if (typeof symbols === 'string') return fail(symbols);
  return { ok: true, value: { ...wait.value, preSeconds: pre, postSeconds: post, symbols } };
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
