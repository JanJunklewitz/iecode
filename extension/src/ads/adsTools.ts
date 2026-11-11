// The ADS tool logic (symbols, watch, read, scope) shared by the Copilot tools (lmTools.ts) and the MCP server. The
// wording lives in core/adsToolText.ts; this module reads the host, the settings and the build output.
// Write is not here: it goes through the write gate.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { NoBuildOutputError, fromBuild } from '../core/adsinterface';
import { ScopeOptions, oneLine, sampleAge } from '../core/adswatch';
import { ScopeArgs } from '../core/toolInput';
import { ToolNames, ToolText, capText, emptyReadText, emptyScopeText, newestSample, readOnceRow, readRow, readText, scopeSummaryText, scopeToolText, symbolsText, waitResultText, watchFailureText, watchListText, watchResultText } from '../core/adsToolText';
import type { WaitCondition } from '../core/waitCondition';
import { WaitDeps, runWait } from '../core/waitRun';
import { AdsHost, StartError, WriteNotSent } from './host';

export type { ToolNames, ToolText };

export interface SymbolsInput { filter: string }
export interface WatchInput { add?: string[]; remove?: string[] }
export interface ReadInput { symbols?: string[] }
export type ScopeInput = Partial<ScopeArgs>;
export interface WaitInput { symbol: string; condition: WaitCondition; timeoutSeconds: number }

const MAX_SYMBOLS = 100;
export const SCOPE_SECONDS = 60;

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

const clock = (ms: number) => new Date(ms).toLocaleTimeString();

/** Errors of a failed host start were already shown to the user; the model gets the reason as text. */
export const errorText = (e: unknown) => `Error: ${(e as Error).message}${e instanceof StartError || (e instanceof WriteNotSent && e.alreadyShown) ? ' (already shown to the user)' : ''}`;

const ok = (text: string): ToolText => ({ text: capText(text) });
const failure = (e: unknown): ToolText => ({ text: capText(errorText(e)), isError: true });

/** Keeps the host alive for the duration of a tool call. */
async function leased<T>(host: AdsHost, fn: () => Promise<T>): Promise<T> {
  const lease = host.use();
  try { return await fn(); } finally { lease.dispose(); }
}

/** The watched spelling of each requested symbol (ADS names are case-insensitive), or undefined if not watched. */
function watchedName(host: AdsHost, symbol: string): string | undefined {
  const s = symbol.trim().toLowerCase();
  return host.watched().find(w => w.toLowerCase() === s);
}

const list = (host: AdsHost) => watchListText(host.items(), host.entries());

/** Summary and table of the symbols over the last seconds, up to their newest sample. */
export function scopeSummary(host: AdsHost, symbols: string[], seconds: number, options: ScopeOptions = {}): string {
  return scopeSummaryText({ buffer: host.buffer, symbols, seconds, target: host.target(), intervalMs: host.sampling().intervalMs, now: Date.now(), clock, options });
}

/** Time of the newest sample of the symbols, or undefined while there is none. */
export const newest = (host: AdsHost, symbols: string[]) => newestSample(host.buffer, symbols);

export function adsTools(ctx: vscode.ExtensionContext, state: WorkspaceState, names: ToolNames) {
  const host = AdsHost.get(ctx);

  return {
    host,

    async symbols(input: SymbolsInput): Promise<ToolText> {
      const typed = (input.filter ?? '').trim();
      const filter = typed.toLowerCase();
      const matches: string[] = [];
      const missing: string[] = [];
      const unreadable: string[] = [];
      let total = 0;
      // a library project can run too (a module with its own MAIN): it counts once it was built
      const units = state.current.units;
      for (const u of units) {
        try {
          for (const s of (await fromBuild(u.plc, true)).symbols) {
            if (filter && !s.name.toLowerCase().includes(filter)) continue;
            if (++total <= MAX_SYMBOLS) matches.push(`${s.name} : ${s.type}`);
          }
        } catch (e) {
          if (e instanceof NoBuildOutputError) { if (!u.plc.isLibrary) missing.push(u.plc.name); }
          else unreadable.push(`${u.plc.name} (${show((e as Error).message)})`);
        }
      }
      return ok(symbolsText({ matches, total, max: MAX_SYMBOLS, typed, missing, unreadable, units: units.length }));
    },

    async watch(input: WatchInput): Promise<ToolText> {
      const { add = [], remove = [] } = input;
      let kept: string[];
      try {
        ({ kept } = await leased(host, () => host.list.aiEdit(add, remove)));
      } catch (e) {
        const f = watchFailureText(errorText(e), list(host));
        return { ...f, text: capText(f.text) };
      }
      return ok(watchResultText({ list: list(host), kept, added: add.length > 0, intervalMs: host.sampling().intervalMs, names }));
    },

    async read(input: ReadInput): Promise<ToolText> {
      const symbols = input.symbols?.length ? input.symbols : host.watched();
      if (!symbols.length) return ok(emptyReadText());
      try {
        return await leased(host, async () => {
          const rows: string[] = [];
          const others: string[] = [];
          for (const s of symbols) {
            const w = watchedName(host, s);
            const v = w ? host.valueAt(w) : undefined;
            if (w && v !== undefined) {
              const item = host.items().find(i => i.symbol.toLowerCase() === w.toLowerCase());
              rows.push(readRow({ symbol: w, type: item?.type ?? '', value: v.value, error: item?.error ?? null, age: sampleAge(v.t, Date.now()) }));
            } else {
              others.push(s.trim());
            }
          }
          if (others.length) {
            for (const r of await host.read(others)) rows.push(readOnceRow(r));
          }
          return ok(readText(host.target(), rows));
        });
      } catch (e) {
        return failure(e);
      }
    },

    scope(input: ScopeInput): ToolText {
      const seconds = Math.min(3600, Math.max(1, Math.round(input.seconds ?? SCOPE_SECONDS)));
      const asked = input.symbols?.length ? input.symbols : host.watched();
      if (!asked.length) return ok(emptyScopeText(names));
      const found = asked.map(s => watchedName(host, s));
      const watched = found.filter((n): n is string => !!n);
      const unwatched = asked.filter((_, i) => !found[i]);
      return ok(scopeToolText(watched.length ? scopeSummary(host, watched, seconds, { maxRows: input.maxRows, decimals: input.decimals }) : undefined, unwatched, names));
    },

    async wait(input: WaitInput, signal: AbortSignal): Promise<ToolText> {
      const deps: WaitDeps = {
        hold: s => host.list.hold(s),
        ready: () => host.ready(),
        onSamples: l => host.onSamples(l),
        onEnded: l => host.onEnded(l),
        onUserRemoved: l => host.list.onUserRemoved(l),
        monotonicMs: () => performance.now(),
        wallMs: () => Date.now(),
        setTimer: (ms, fn) => { const t = setTimeout(fn, ms); return { dispose: () => clearTimeout(t) }; },
      };
      // the host keeps running for the whole wait, whatever way it ends
      const outcome = await leased(host, () => runWait(deps, input, signal));
      const r = waitResultText({ symbol: input.symbol.trim(), condition: input.condition, outcome, intervalMs: host.sampling().intervalMs, clock });
      return { ...r, text: capText(r.text) };
    },
  };
}
