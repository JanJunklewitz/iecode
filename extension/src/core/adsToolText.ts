// Result texts of the ADS tools, shared by the Copilot tools and the MCP server. Pure: plain data in, text out, so the
// wording is pinned by tests and does not drift between the two clients.

import { HostEnd, ScopeBuffer, ScopeOptions, WatchEntry, WatchItem, gapNote, hostNote, scopeText } from './adswatch';
import { WaitCondition, conditionText } from './waitCondition';
import type { WaitOutcome } from './waitRun';
import type { WatchRunResult } from './watchRequest';
import { groupSummaries, isActive } from './watchGroups';

/** What a client calls the tools in the texts that point from one tool to another. */
export interface ToolNames { watch: string; scope: string; write: string; wait: string }

export const COPILOT_NAMES: ToolNames = { watch: 'adsWatch', scope: 'adsScope', write: 'adsWrite', wait: 'adsWait' };
export const MCP_NAMES: ToolNames = { watch: 'ads_watch', scope: 'ads_scope', write: 'ads_write', wait: 'ads_wait' };

export interface ToolText { text: string; isError?: boolean }

/** Longest result a tool returns, in characters (the marker included). */
export const MAX_TOOL_TEXT = 50_000;
/** What the scope text may use; the rest of MAX_TOOL_TEXT is left for the head line, the gap note and the unwatched list. */
export const SCOPE_TEXT_BUDGET = MAX_TOOL_TEXT - 2000;
export const TRUNCATED = '(output truncated: ask for fewer symbols or a shorter time span)';

export function capText(text: string, limit = MAX_TOOL_TEXT): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - TRUNCATED.length - 1);
  return `${text.slice(0, room)}\n${TRUNCATED}`.slice(0, limit);
}

/** The full list. `off` holds the keys of switched-off groups; their entries are listed apart, not sampled. */
export function watchListText(items: WatchItem[], entries: WatchEntry[], off: readonly string[] = []): string {
  const byName = new Map(entries.map(e => [e.symbol.toLowerCase(), e]));
  const label = (e: WatchEntry | undefined) => (e?.groups?.length ? ` [group ${e.groups.join(', ')}]` : '');
  const lines = items.length
    ? items.map(i => {
      const e = byName.get(i.symbol.toLowerCase());
      return `${i.symbol} : ${i.type || '?'}${i.error ? ` (error: ${i.error})` : ''}${e?.ai ? ' [added by AI]' : ' [added by the user]'}${label(e)}`;
    })
    : ['The ADS watch list is empty.'];
  const shown = new Set(items.map(i => i.symbol.toLowerCase()));
  const parked = entries.filter(e => !shown.has(e.symbol.toLowerCase()) && !isActive(e, off));
  if (parked.length) lines.push(`Switched off (not sampled): ${parked.map(e => `${e.symbol}${label(e)}`).join(', ')}`);
  const groups = groupSummaries(entries, off);
  if (groups.length) lines.push(`Groups: ${groups.map(g => `${g.name} ${g.on ? 'on' : 'off'} (${g.count})`).join(', ')}`);
  return lines.join('\n');
}

export const targetLine = (target: string): string => `ADS target: ${target}`;

/** "<target>:<port>" (the gate's key) as the user knows it: the default port 851 is left out. */
export const targetOfKey = (key: string): string => (key.endsWith(':851') ? key.slice(0, -4) : key);

export interface WatchResultInput {
  target: string;
  /** Name of the group of an add with `group`. */
  group?: string;
  /** Entries in the list that are not sampled (switched-off groups). */
  parked: number;
  full: boolean;
  list: string;
  result: WatchRunResult;
  addErrors: string[];
  count: number;
  intervalMs: number;
  names: ToolNames;
}

/** `<stored symbol> : <error>` for each added symbol the host could not resolve. */
export function addErrorLines(items: WatchItem[], added: string[]): string[] {
  const wanted = new Set(added.map(a => a.toLowerCase()));
  return items.filter(i => i.error && wanted.has(i.symbol.toLowerCase())).map(i => `${i.symbol} : ${i.error}`);
}

/** The text of the dialog that asks the user to let the AI remove entries they added. */
export function confirmRemoveText(symbols: string[]): string {
  const shown = symbols.slice(0, 10);
  const lines = [`An AI tool asks to remove ${symbols.length} variable${symbols.length === 1 ? '' : 's'} you added from the ADS Watch list:`, ...shown];
  if (symbols.length > shown.length) lines.push(`(and ${symbols.length - shown.length} more)`);
  return lines.join('\n');
}

/** What the call changed (and the count), or the full list for an empty call and `list: true`. */
export function watchResultText(o: WatchResultInput): string {
  const r = o.result;
  const lines: string[] = [];
  if (r.added.length) lines.push(`Added: ${r.added.join(', ')}`);
  if (r.already.length) lines.push(`Already in the list: ${r.already.join(', ')}`);
  if (r.removed.length) lines.push(`Removed: ${r.removed.join(', ')}`);
  if (r.missing.length) lines.push(`Not in the list: ${r.missing.join(', ')}`);
  if (r.kept.length) lines.push(`Not removed (added by the user, only the user can remove them): ${r.kept.join(', ')}`);
  if (r.declined.length) lines.push(`Not removed (the user did not confirm): ${r.declined.join(', ')}`);
  if (r.held.length) lines.push(`Kept until a running wait ends: ${r.held.join(', ')}`);
  if (r.grouped?.length) lines.push(`Group ${o.group}: ${r.grouped.join(', ')}`);
  if (r.switchedOn) lines.push(`Group ${o.group} switched on (it was off)`);
  if (r.ungrouped?.length) lines.push(`Not grouped (added by the user): ${r.ungrouped.join(', ')}`);
  const op = r.groupOp;
  const symbols = (n: number) => `${n} symbol${n === 1 ? '' : 's'}`;
  if (op) {
    if (op.action === 'on') lines.push(`Group ${op.name} switched on (${symbols(op.members)})`);
    else if (op.action === 'off') lines.push(`Group ${op.name} switched off (${symbols(op.members)}, not sampled now)`);
    else if (op.action === 'removed') lines.push(`Group ${op.name} removed`);
    else lines.push(`No group named ${op.name}`);
  }
  for (const e of o.addErrors) lines.push(`Error: ${e}`);
  lines.push(o.full ? o.list : `Watch list: ${symbols(o.count)}${o.parked > 0 ? `, ${o.parked} switched off` : ''}`);
  if (r.added.length) lines.push(`New values arrive every ${o.intervalMs} ms; use ${o.names.scope} for the history.`);
  lines.push(targetLine(o.target));
  return lines.join('\n');
}

/** A list over the limit was not saved, one the host could not start for was: either way the list shows what is left. */
export function watchFailureText(error: string, list: string): ToolText {
  return { text: `${error}\nWatch list now:\n${list}`, isError: true };
}

export function symbolsText(o: { matches: string[]; total: number; max: number; typed: string; missing: string[]; unreadable: string[]; units: number }): string {
  const lines = [o.matches.length ? o.matches.join('\n') : `No symbols match "${o.typed}".`];
  if (o.total > o.max) lines.push(`(${o.total - o.max} more not listed; use a narrower filter)`);
  if (o.missing.length) lines.push(`Not built, so not listed (no .tmc): ${o.missing.join(', ')}`);
  if (o.unreadable.length) lines.push(`Build output unreadable, so not listed: ${o.unreadable.join('; ')}`);
  if (!o.units) lines.push('No PLC projects in this workspace.');
  return lines.join('\n');
}

export interface ReadRow { symbol: string; type: string; value: string | null; error: string | null; age?: string }

/** A watched symbol; `age` only for a value from the sample buffer (a value read back by a write has no time). */
export function readRow(r: ReadRow): string {
  const value = r.value ?? `(read error${r.error ? `: ${r.error}` : ''})`;
  return `${r.symbol} : ${r.type || '?'} = ${value}${r.age ? ` (${r.age})` : ''}`;
}

/** A symbol that was read once, not watched. */
export function readOnceRow(r: ReadRow): string {
  return r.error ? `${r.symbol} : error ${r.error}` : `${r.symbol} : ${r.type || '?'} = ${r.value}`;
}

export const readText = (target: string, rows: string[]): string => `Values on ${target}:\n${rows.join('\n')}`;

export const emptyReadText = (): string => 'Nothing to read: no symbols given and the ADS watch list is empty.';

export const emptyScopeText = (names: ToolNames): string => `The ADS watch list is empty; add symbols with ${names.watch} first.`;

/** Time of the newest sample of the symbols; the host's clock, like the scope view's right edge. */
export function newestSample(buffer: ScopeBuffer, symbols: string[]): number | undefined {
  let t = -Infinity;
  for (const s of symbols) { const l = buffer.latest(s); if (l) t = Math.max(t, l.t); }
  return t === -Infinity ? undefined : t;
}

export function scopeSummaryText(o: { buffer: ScopeBuffer; symbols: string[]; seconds: number; target: string; intervalMs: number; now: number; clock: (ms: number) => string; options?: ScopeOptions; state?: { connected: boolean; error?: string }; ended?: HostEnd }): string {
  const end = newestSample(o.buffer, o.symbols);
  const note = hostNote(o.state, o.ended, o.clock, end);
  if (end === undefined) return `No samples yet for ${o.symbols.join(', ')}. The values are sampled every ${o.intervalMs} ms while the ADS host runs.${note ? ` ${note}` : ''}`;
  const gap = gapNote(end, o.now, o.clock, note);
  const view = o.options?.edges ? 'edges' : o.options?.changesOnly ? 'value changes' : 'values';
  const closing = o.options?.edges ? `\nSampled every ${o.intervalMs} ms; edges shorter than one sample are not seen.` : '';
  const head = `ADS ${view} of the last ${o.seconds} s up to the newest sample (target ${o.target}):`;
  return `${gap ? `${gap}\n` : ''}${head}\n${scopeText(o.buffer, o.symbols, o.seconds, end, { maxChars: SCOPE_TEXT_BUDGET, ...o.options })}${closing}`;
}

export function scopeToolText(summary: string | undefined, unwatched: string[], names: ToolNames): string {
  const lines: string[] = [];
  if (unwatched.length) lines.push(`Not watched, so no history (add them with ${names.watch}): ${unwatched.join(', ')}`);
  if (summary) lines.push(summary);
  return lines.join('\n\n');
}

/** The resolution is the sample interval; the closing line keeps an agent from reading a missed change as proof it never happened. */
export function waitResultText(o: { symbol: string; condition: WaitCondition; outcome: WaitOutcome; intervalMs: number; clock: (ms: number) => string; target: string }): ToolText {
  const out = o.outcome;
  const tl = `\n${targetLine(o.target)}`;
  const sampled = `Sampled every ${o.intervalMs} ms; changes between samples are not seen.`;
  switch (out.kind) {
    case 'met': {
      const first = out.firstObservation ? ' (true at the first observation)' : '';
      return { text: `Condition met at ${o.clock(out.t)} (after ${(out.elapsedMs / 1000).toFixed(2)} s): ${o.symbol} = ${out.value}${first}\n${sampled}${tl}` };
    }
    case 'timeout': {
      const last = out.last === undefined ? 'no valid value observed' : `last value ${out.last}`;
      const seen = out.seenEnum ? `; enum names seen: ${out.seenEnum.join(', ')} (a name never seen may be misspelled)` : '';
      return { text: `Not met within ${out.seconds} s: ${o.symbol} ${conditionText(o.condition)}; ${last}${seen}\n${sampled}${tl}` };
    }
    case 'ended': return { text: `Wait ended: ${out.reason}${tl}` };
    case 'refused': return { text: `Error: ${out.reason}${tl}`, isError: true };
    case 'cancelled': return { text: `Wait cancelled.${tl}` };
  }
}
