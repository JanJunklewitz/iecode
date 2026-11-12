// The ADS tool logic (symbols, watch, read, scope) shared by the Copilot tools (lmTools.ts) and the MCP server. The
// wording lives in core/adsToolText.ts; this module reads the host, the settings and the build output.
// Write is not here: it goes through the write gate.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { NoBuildOutputError, findTmc, fromBuild, fromSourceAt, matchingPropertiesAt, sourceObjects } from '../core/adsinterface';
import { pickEnum } from '../core/enumLookup';
import { ConfigRunner } from '../core/adsConfig';
import { PAGE_SIZE, SymbolQuery, matchesQuery, queryText } from '../core/symbolQuery';
import { promises as fsp } from 'fs';
import { buildHeader } from '../core/symbolOrigin';
import { ScopeOptions, oneLine, sampleAge } from '../core/adswatch';
import { ScopeArgs, WatchRequest, wantsFullList } from '../core/toolInput';
import { ToolNames, ToolText, capText, emptyReadText, emptyScopeText, newestSample, readOnceRow, readRow, readText, addErrorLines, confirmRemoveText, scopeSummaryText, scopeToolText, symbolsText, configText, propertyHintText, enumText, noEnumText, hiddenText, waitResultText, watchFailureText, watchListText, watchResultText } from '../core/adsToolText';
import type { WaitCondition } from '../core/waitCondition';
import { ConfirmUserRemoval, WatchRunResult, runWatchRequest } from '../core/watchRequest';
import { output } from '../cli/iecode';
import { WaitDeps, runWait } from '../core/waitRun';
import { AdsHost, StartError, WriteNotSent } from './host';

export type { ToolNames, ToolText };

export interface SymbolsInput { filter?: string; enumType?: string; hidden?: boolean; prefix?: string; type?: string; offset?: number }
export type WatchInput = WatchRequest;
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

const CONFIRM_REMOVE_MS = 120_000;

/** The dialog is raced against the call's signal and a timer: VS Code cannot close a modal, so a late answer is ignored. */
const askRemoval: ConfirmUserRemoval = (symbols, signal) => new Promise<boolean>(resolve => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const done = (answer: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    resolve(answer);
  };
  const onAbort = () => done(false);
  if (signal.aborted) return done(false);
  signal.addEventListener('abort', onAbort);
  timer = setTimeout(() => done(false), CONFIRM_REMOVE_MS);
  vscode.window.showWarningMessage(confirmRemoveText(symbols), { modal: true }, 'Remove').then(a => done(a === 'Remove'), () => done(false));
});

/** One dialog at a time for MCP and Copilot calls alike; a call that waits its turn with an aborted signal answers "no" without a dialog. */
let dialogs: Promise<unknown> = Promise.resolve();
const confirmRemove: ConfirmUserRemoval = (symbols, signal) => {
  const answer = dialogs.then(() => askRemoval(symbols, signal));
  dialogs = answer.catch(() => undefined);
  return answer;
};

const list = (host: AdsHost) => watchListText(host.items(), host.entries(), host.groupsOff());

/** Summary and table of the symbols over the last seconds, up to their newest sample. */
export function scopeSummary(host: AdsHost, symbols: string[], seconds: number, options: ScopeOptions = {}): string {
  return scopeSummaryText({ buffer: host.buffer, symbols, seconds, target: host.target(), intervalMs: host.sampling().intervalMs, now: Date.now(), clock, options, state: host.state(), ended: host.lastEnded() });
}

/** Time of the newest sample of the symbols, or undefined while there is none. */
export const newest = (host: AdsHost, symbols: string[]) => newestSample(host.buffer, symbols);


type Unit = WorkspaceState['current']['units'][number];

/** The members of an enum type, from the build output of the first project that has it, else from the source. */
async function enumAnswer(units: readonly Unit[], name: string): Promise<string> {
  for (const u of units) {
    const tmcFile = await findTmc(u.plc.file);
    const tmc = tmcFile ? await fsp.readFile(tmcFile, 'utf8').catch(() => undefined) : undefined;
    const hit = pickEnum(tmc, await sourceObjects(u.plc), name);
    if (hit) {
      // alias writes by name need the CLI part of the enum alias work, which no released CLI has yet
      return enumText({ info: hit.info, from: `${hit.origin === 'build' ? 'the build output' : 'the source code'} of ${u.plc.name}`, aliasWrite: 'unknown' });
    }
  }
  return noEnumText(name);
}

/** A courtesy: names a matching property of the source for a symbol that was not found; a failing source read just gives none. */
async function propertyHint(units: readonly Unit[], symbol: string): Promise<string | undefined> {
  for (const u of units) {
    try {
      const props = await matchingPropertiesAt(u.plc, symbol);
      if (props.length) return propertyHintText(props);
    } catch { /* the original error stays */ }
  }
  return undefined;
}

/** Variables marked {attribute 'hide'}: from the source only (the build output does not list them). */
async function hiddenAnswer(units: readonly Unit[], filter: string): Promise<string> {
  const rows: string[] = [];
  let total = 0;
  for (const u of units) {
    for (const s of (await fromSourceAt(u.plc, undefined, true, true).catch(() => undefined))?.symbols ?? []) {
      if (!s.hidden || (filter && !s.name.toLowerCase().includes(filter))) continue;
      if (++total <= MAX_SYMBOLS) rows.push(`${s.name} : ${s.type}`);
    }
  }
  return total ? hiddenText(rows, total) : 'No hidden variables match.';
}

export function adsTools(ctx: vscode.ExtensionContext, state: WorkspaceState, names: ToolNames) {
  const host = AdsHost.get(ctx);
  const configRunner = new ConfigRunner({
    current: () => host.sampling(),
    symbols: () => host.watched().length,
    confirm: async text => (await vscode.window.showWarningMessage(text, { modal: true }, 'Apply')) === 'Apply',
    apply: next => host.applySampling(next),
    setTimer: (ms, fn) => { const t = setTimeout(fn, ms); return { dispose: () => clearTimeout(t) }; },
  });

  return {
    host,

    async symbols(input: SymbolsInput): Promise<ToolText> {
      // Copilot hands the input over unparsed
      const enumName = typeof input.enumType === 'string' ? input.enumType.trim() : '';
      if (enumName) return ok(await enumAnswer(state.current.units, enumName));
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const query: SymbolQuery = {
        filter: str(input.filter), prefix: str(input.prefix), type: str(input.type),
        offset: typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0,
      };
      const typed = queryText(query);
      const filter = query.filter.toLowerCase();
      const all: string[] = [];
      const missing: string[] = [];
      const unreadable: string[] = [];
      const headers: string[] = [];
      // a library project can run too (a module with its own MAIN): it counts once it was built
      const units = state.current.units;
      for (const u of units) {
        try {
          const built = await fromBuild(u.plc, true);
          headers.push(...buildHeader({ unit: u.plc.name, builtAt: built.builtAt!, newer: built.newerSources ?? [] }));
          for (const s of built.symbols) if (matchesQuery(s, query)) all.push(`${s.name} : ${s.type}`);
        } catch (e) {
          if (e instanceof NoBuildOutputError) { if (!u.plc.isLibrary) missing.push(u.plc.name); }
          else unreadable.push(`${u.plc.name} (${show((e as Error).message)})`);
        }
      }
      const matches = all.slice(query.offset, query.offset + PAGE_SIZE);
      const listing = symbolsText({ headers, matches, total: all.length, max: PAGE_SIZE, offset: query.offset, typed, missing, unreadable, units: units.length });
      return ok(input.hidden === true ? `${listing}\n${await hiddenAnswer(units, filter)}` : listing);
    },

    async config(input: { pollMs?: number; bufferSeconds?: number }, signal: AbortSignal): Promise<ToolText> {
      try {
        return ok(configText({ outcome: await configRunner.run(input, signal), target: host.target() }).text);
      } catch (e) {
        return failure(e);
      }
    },

    async watch(input: WatchInput, signal: AbortSignal): Promise<ToolText> {
      let result: WatchRunResult;
      const owned = new Set(input.force ? host.list.userOwned(input.remove).map(x => x.toLowerCase()) : []);
      try {
        result = await leased(host, () => runWatchRequest(host.list, input, confirmRemove, signal));
      } catch (e) {
        const f = watchFailureText(errorText(e), list(host));
        return { ...f, text: capText(f.text) };
      }
      const taken = result.removed.filter(r => owned.has(r.toLowerCase())).length;
      if (taken) output.info(`AI removed ${taken} variable${taken === 1 ? '' : 's'} the user added (confirmed)`);
      const hints: string[] = [];
      for (const i of host.items()) {
        if (!i.error || !/not found/i.test(i.error) || !result.added.some(a => a.toLowerCase() === i.symbol.toLowerCase())) continue;
        const h = await propertyHint(state.current.units, i.symbol);
        if (h) hints.push(`Hint for ${i.symbol}: ${h}`);
      }
      return ok(watchResultText({ hints, full: wantsFullList(input), list: list(host), result, addErrors: addErrorLines(host.items(), result.added), count: host.watched().length, parked: Math.max(0, host.entries().length - host.watched().length), group: input.group, unresolved: host.unresolved.take(host.items(), result.added), intervalMs: host.sampling().intervalMs, names, target: host.target() }));
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
            for (const r of await host.read(others)) rows.push(readOnceRow(/not found/i.test(r.error ?? '') ? { ...r, hint: await propertyHint(state.current.units, r.symbol) } : r));
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
      const parkedEntries = host.entries().filter(e => e.groups?.length && unwatched.some(u => u.trim().toLowerCase() === e.symbol.toLowerCase()));
      const parkedNames = new Set(parkedEntries.map(e => e.symbol.toLowerCase()));
      const parked = parkedEntries.map(e => `${e.symbol} [group ${e.groups?.join(', ')}]`);
      return ok(scopeToolText(watched.length ? scopeSummary(host, watched, seconds, { maxRows: input.maxRows, decimals: input.decimals, changesOnly: input.changesOnly, edges: input.edges }) : undefined, unwatched.filter(u => !parkedNames.has(u.trim().toLowerCase())), names, parked));
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
      // the target the wait started on: a settings change during the wait must not be named as its target
      const target = host.target();
      // the host keeps running for the whole wait, whatever way it ends
      const outcome = await leased(host, () => runWait(deps, input, signal));
      const r = waitResultText({ symbol: input.symbol.trim(), condition: input.condition, outcome, intervalMs: host.sampling().intervalMs, clock, target });
      return { ...r, text: capText(r.text) };
    },
  };
}
