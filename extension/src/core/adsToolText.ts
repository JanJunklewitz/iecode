// Result texts of the ADS tools, shared by the Copilot tools and the MCP server. Pure: plain data in, text out, so the
// wording is pinned by tests and does not drift between the two clients.

import { ScopeBuffer, WatchEntry, WatchItem, gapNote, scopeText } from './adswatch';
import { WaitCondition, conditionText } from './waitCondition';
import type { WaitOutcome } from './waitRun';

/** What a client calls the tools in the texts that point from one tool to another. */
export interface ToolNames { watch: string; scope: string; write: string; wait: string }

export const COPILOT_NAMES: ToolNames = { watch: 'adsWatch', scope: 'adsScope', write: 'adsWrite', wait: 'adsWait' };
export const MCP_NAMES: ToolNames = { watch: 'ads_watch', scope: 'ads_scope', write: 'ads_write', wait: 'ads_wait' };

export interface ToolText { text: string; isError?: boolean }

/** Longest result a tool returns, in characters (the marker included). */
export const MAX_TOOL_TEXT = 50_000;
export const TRUNCATED = '(output truncated: ask for fewer symbols or a shorter time span)';

export function capText(text: string, limit = MAX_TOOL_TEXT): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - TRUNCATED.length - 1);
  return `${text.slice(0, room)}\n${TRUNCATED}`.slice(0, limit);
}

export function watchListText(items: WatchItem[], entries: WatchEntry[]): string {
  if (!items.length) return 'The ADS watch list is empty.';
  const ai = new Set(entries.filter(e => e.ai).map(e => e.symbol.toLowerCase()));
  return items.map(i => `${i.symbol} : ${i.type || '?'}${i.error ? ` (error: ${i.error})` : ''}${ai.has(i.symbol.toLowerCase()) ? ' [added by AI]' : ' [added by the user]'}`).join('\n');
}

export function watchResultText(o: { list: string; kept: string[]; added: boolean; intervalMs: number; names: ToolNames }): string {
  const lines = [o.list];
  if (o.kept.length) lines.push(`Not removed (added by the user, only the user can remove them): ${o.kept.join(', ')}`);
  if (o.added) lines.push(`New values arrive every ${o.intervalMs} ms; use ${o.names.scope} for the history.`);
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

export function scopeSummaryText(o: { buffer: ScopeBuffer; symbols: string[]; seconds: number; target: string; intervalMs: number; now: number; clock: (ms: number) => string }): string {
  const end = newestSample(o.buffer, o.symbols);
  if (end === undefined) return `No samples yet for ${o.symbols.join(', ')}. The values are sampled every ${o.intervalMs} ms while the ADS host runs.`;
  const gap = gapNote(end, o.now, o.clock);
  const head = `ADS values of the last ${o.seconds} s up to the newest sample (target ${o.target}):`;
  return `${gap ? `${gap}\n` : ''}${head}\n${scopeText(o.buffer, o.symbols, o.seconds, end)}`;
}

export function scopeToolText(summary: string | undefined, unwatched: string[], names: ToolNames): string {
  const lines: string[] = [];
  if (unwatched.length) lines.push(`Not watched, so no history (add them with ${names.watch}): ${unwatched.join(', ')}`);
  if (summary) lines.push(summary);
  return lines.join('\n\n');
}

/** The resolution is the sample interval; the closing line keeps an agent from reading a missed change as proof it never happened. */
export function waitResultText(o: { symbol: string; condition: WaitCondition; outcome: WaitOutcome; intervalMs: number; clock: (ms: number) => string }): ToolText {
  const out = o.outcome;
  const sampled = `Sampled every ${o.intervalMs} ms; changes between samples are not seen.`;
  switch (out.kind) {
    case 'met': {
      const first = out.firstObservation ? ' (true at the first observation)' : '';
      return { text: `Condition met at ${o.clock(out.t)} (after ${(out.elapsedMs / 1000).toFixed(2)} s): ${o.symbol} = ${out.value}${first}\n${sampled}` };
    }
    case 'timeout': {
      const last = out.last === undefined ? 'no valid value observed' : `last value ${out.last}`;
      const seen = out.seenEnum ? `; enum names seen: ${out.seenEnum.join(', ')} (a name never seen may be misspelled)` : '';
      return { text: `Not met within ${out.seconds} s: ${o.symbol} ${conditionText(o.condition)}; ${last}${seen}\n${sampled}` };
    }
    case 'ended': return { text: `Wait ended: ${out.reason}` };
    case 'refused': return { text: `Error: ${out.reason}`, isError: true };
    case 'cancelled': return { text: 'Wait cancelled.' };
  }
}
