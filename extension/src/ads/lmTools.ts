// Language model tools (Copilot Chat agent mode) on the ADS host: list symbols, edit the watch list, read values,
// summarize the sample buffer, and write per iecode.ads.aiWrites. Plus "Add to AI Chat" for the watch view and the
// AI write access picker. Claude Code cannot call vscode.lm tools; for it the AI path is "Add to AI Chat".

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { fromBuild } from '../core/adsinterface';
import { WriteDecision, aiWriteDecision, oneLine, scopeText, watchEdit, workspaceOverrides, writeStillApproved } from '../core/adswatch';
import { output } from '../cli/iecode';
import { sendToAiChat } from '../commands/aiChat';
import { AdsHost, StartError } from './host';

const MAX_SYMBOLS = 100;
const SCOPE_SECONDS = 60;
const STALE_MS = 2000;

/**
 * `iecode.ads.aiWrites` from the user settings only. The setting is application-scoped; reading the global value
 * also keeps a workspace `.vscode/settings.json` from turning on auto-approve should VS Code ever apply one.
 */
export function aiWritesSetting(): string {
  return vscode.workspace.getConfiguration('iecode.ads').inspect<string>('aiWrites')?.globalValue ?? 'off';
}

/**
 * True if the workspace settings, or the settings of any workspace folder (multi-root), point iecode.ads.target or
 * .port somewhere else than the user settings.
 */
function workspaceTarget(): boolean {
  const scopes = [undefined, ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)];
  return scopes.some(uri => {
    const c = vscode.workspace.getConfiguration('iecode.ads', uri);
    return workspaceOverrides(c.inspect<string>('target')) || workspaceOverrides(c.inspect<number>('port'));
  });
}

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

/** Errors of a failed host start were already shown to the user; the model gets the reason as text. */
const errorText = (e: unknown) => `Error: ${(e as Error).message}${e instanceof StartError ? ' (already shown to the user)' : ''}`;
const failure = (e: unknown) => text(errorText(e));

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

function list(host: AdsHost): string {
  const ai = new Set(host.entries().filter(e => e.ai).map(e => e.symbol.toLowerCase()));
  const items = host.items();
  if (!items.length) return 'The ADS watch list is empty.';
  return items.map(i => `${i.symbol} : ${i.type || '?'}${i.error ? ` (error: ${i.error})` : ''}${ai.has(i.symbol.toLowerCase()) ? ' [added by AI]' : ' [added by the user]'}`).join('\n');
}

/** Time of the newest sample of the symbols; the host's clock, like the scope view's right edge. */
function newest(host: AdsHost, symbols: string[]): number | undefined {
  let t = -Infinity;
  for (const s of symbols) { const l = host.buffer.latest(s); if (l) t = Math.max(t, l.t); }
  return t === -Infinity ? undefined : t;
}

function scopeSummary(host: AdsHost, symbols: string[], seconds: number): string {
  const end = newest(host, symbols);
  if (end === undefined) return `No samples yet for ${symbols.join(', ')}. The values are sampled every ${vscode.workspace.getConfiguration('iecode.ads').get<number>('sampleIntervalMs', 100)} ms while the ADS host runs.`;
  const age = Date.now() - end;
  const head = `ADS values of the last ${seconds} s up to the newest sample (target ${host.target()})${age > STALE_MS ? `; the newest sample is ${Math.round(age / 1000)} s old, the host may have stopped` : ''}:`;
  return `${head}\n${scopeText(host.buffer, symbols, seconds, end)}`;
}

interface SymbolsInput { filter: string }
interface WatchInput { add?: string[]; remove?: string[] }
interface ReadInput { symbols?: string[] }
interface ScopeInput { symbols?: string[]; seconds?: number }
interface WriteInput { symbol: string; value: string }

export function registerAdsLmTools(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const host = AdsHost.get(ctx);

  const symbolsTool: vscode.LanguageModelTool<SymbolsInput> = {
    async invoke(opts) {
      const filter = (opts.input.filter ?? '').trim().toLowerCase();
      const out: string[] = [];
      const missing: string[] = [];
      let total = 0;
      const units = state.current.units.filter(u => !u.plc.isLibrary);
      for (const u of units) {
        try {
          for (const s of (await fromBuild(u.plc, true)).symbols) {
            if (filter && !s.name.toLowerCase().includes(filter)) continue;
            if (++total <= MAX_SYMBOLS) out.push(`${s.name} : ${s.type}`);
          }
        } catch {
          missing.push(u.plc.name);
        }
      }
      const lines = [out.length ? out.join('\n') : `No symbols match "${filter}".`];
      if (total > MAX_SYMBOLS) lines.push(`(${total - MAX_SYMBOLS} more not listed; use a narrower filter)`);
      if (missing.length) lines.push(`Not built, so not listed (no .tmc): ${missing.join(', ')}`);
      if (!units.length) lines.push('No PLC projects in this workspace.');
      return text(lines.join('\n'));
    },
  };

  const watchTool: vscode.LanguageModelTool<WatchInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Updating the ADS watch list' }),
    async invoke(opts) {
      const { add = [], remove = [] } = opts.input;
      const before = host.entries();
      const next = watchEdit(before, add, remove, true);
      const kept = remove.filter(r => next.some(e => e.symbol.toLowerCase() === r.trim().toLowerCase()));
      try {
        await leased(host, () => host.setEntries(next));
      } catch (e) {
        // a list over the limit was not saved, one the host could not start for was
        return text(`${errorText(e)}\nWatch list now:\n${list(host)}`);
      }
      const lines = [list(host)];
      if (kept.length) lines.push(`Not removed (added by the user, only the user can remove them): ${kept.join(', ')}`);
      if (add.length) lines.push(`New values arrive every ${vscode.workspace.getConfiguration('iecode.ads').get<number>('sampleIntervalMs', 100)} ms; use adsScope for the history.`);
      return text(lines.join('\n'));
    },
  };

  const readTool: vscode.LanguageModelTool<ReadInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading ADS values' }),
    async invoke(opts) {
      const symbols = opts.input.symbols?.length ? opts.input.symbols : host.watched();
      if (!symbols.length) return text('Nothing to read: no symbols given and the ADS watch list is empty.');
      try {
        return await leased(host, async () => {
          const rows: string[] = [];
          const others: string[] = [];
          for (const s of symbols) {
            const w = watchedName(host, s);
            const v = w ? host.value(w) : undefined;
            if (w && v !== undefined) {
              const item = host.items().find(i => i.symbol === w);
              rows.push(`${w} : ${item?.type || '?'} = ${v ?? `(read error${item?.error ? `: ${item.error}` : ''})`}`);
            } else {
              others.push(s.trim());
            }
          }
          if (others.length) {
            for (const r of await host.read(others)) rows.push(r.error ? `${r.symbol} : error ${r.error}` : `${r.symbol} : ${r.type || '?'} = ${r.value}`);
          }
          return text(`Values on ${host.target()}:\n${rows.join('\n')}`);
        });
      } catch (e) {
        return failure(e);
      }
    },
  };

  const scopeTool: vscode.LanguageModelTool<ScopeInput> = {
    invoke(opts) {
      const seconds = Math.min(3600, Math.max(1, Math.round(opts.input.seconds ?? SCOPE_SECONDS)));
      const asked = opts.input.symbols?.length ? opts.input.symbols : host.watched();
      if (!asked.length) return text('The ADS watch list is empty; add symbols with adsWatch first.');
      const names = asked.map(s => watchedName(host, s));
      const watched = names.filter((n): n is string => !!n);
      const lines: string[] = [];
      const unwatched = asked.filter((_, i) => !names[i]);
      if (unwatched.length) lines.push(`Not watched, so no history (add them with adsWatch): ${unwatched.join(', ')}`);
      if (watched.length) lines.push(scopeSummary(host, watched, seconds));
      return text(lines.join('\n\n'));
    },
  };

  // The decision each prepared write was shown with; invoke checks it against the settings at that time.
  const prepared = new Map<string, WriteDecision>();
  const writeKey = (input: WriteInput) => JSON.stringify([input.symbol, input.value]);

  const writeTool: vscode.LanguageModelTool<WriteInput> = {
    prepareInvocation(opts) {
      const symbol = show(opts.input.symbol), value = show(opts.input.value);
      const setting = aiWritesSetting();
      const redirected = workspaceTarget();
      const decision = aiWriteDecision(setting, redirected);
      // writes the user declined never reach invoke; keep the map from growing on them
      if (prepared.size >= 100) prepared.clear();
      prepared.set(writeKey(opts.input), decision);
      if (decision !== 'confirm') return { invocationMessage: decision === 'allow' ? `Writing ${symbol} := ${value}` : undefined };
      const note = setting === 'auto' && redirected ? ' (the workspace settings set the ADS target or port, so auto-approve does not apply)' : '';
      return {
        invocationMessage: `Writing ${symbol} := ${value}`,
        confirmationMessages: { title: 'Write PLC variable', message: `Write ${symbol} := ${value} on ${host.target()}?${note}` },
      };
    },
    async invoke(opts) {
      const { symbol, value } = opts.input;
      const before = prepared.get(writeKey(opts.input));
      prepared.delete(writeKey(opts.input));
      const now = aiWriteDecision(aiWritesSetting(), workspaceTarget());
      if (now === 'refuse') {
        return text('Not written: AI writes are off. The user can allow them with the command "IECode: Set AI Write Access…" (setting iecode.ads.aiWrites in the user settings).');
      }
      if (!writeStillApproved(before, now)) {
        return text('Not written: the AI write access or the ADS target settings changed after this write was prepared, so it now needs the user\'s confirmation. Call adsWrite again to ask for it.');
      }
      output.info(`AI write ${show(symbol)} := ${show(value)} on ${host.target()}`);
      try {
        const back = await host.write(symbol, value);
        return text(`Written. ${symbol} reads back as ${back}.`);
      } catch (e) {
        output.warn(`AI write ${show(symbol)} failed: ${show((e as Error).message)}`);
        return failure(e);
      }
    },
  };

  ctx.subscriptions.push(
    vscode.lm.registerTool('iecode_ads_symbols', symbolsTool),
    vscode.lm.registerTool('iecode_ads_watch', watchTool),
    vscode.lm.registerTool('iecode_ads_read', readTool),
    vscode.lm.registerTool('iecode_ads_scope', scopeTool),
    vscode.lm.registerTool('iecode_ads_write', writeTool),
    vscode.commands.registerCommand('iecode.adsWatchAiChat', async () => {
      const symbols = host.watched();
      if (!symbols.length) return vscode.window.showInformationMessage('IECode: the ADS watch list is empty, nothing to send.');
      await sendToAiChat(scopeSummary(host, symbols, SCOPE_SECONDS));
    }),
    vscode.commands.registerCommand('iecode.adsAiWrites', async () => {
      const current = aiWritesSetting();
      const picks: (vscode.QuickPickItem & { value: string })[] = [
        { value: 'off', label: 'Off', detail: 'AI tools cannot write PLC variables.' },
        { value: 'confirm', label: 'Confirm each write', detail: 'You confirm every AI write, unless you chose "Always Allow" for the adsWrite tool in the chat.' },
        { value: 'auto', label: 'Auto-approve', detail: 'IECode writes without asking; VS Code may still ask by its own tool approval rules.' },
      ];
      for (const p of picks) if (p.value === current) p.description = '(current)';
      const pick = await vscode.window.showQuickPick(picks, { title: 'AI write access to the PLC (iecode.ads.aiWrites)' });
      if (pick) await vscode.workspace.getConfiguration('iecode.ads').update('aiWrites', pick.value, vscode.ConfigurationTarget.Global);
    }),
  );
}
