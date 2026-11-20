// Language model tools (Copilot Chat agent mode) on the ADS host: list symbols, edit the watch list, read values,
// summarize the sample buffer, and write per iecode.ads.aiWrites. Plus "Add to AI Chat" for the watch view and the
// AI write access picker. The read-only tools are thin wrappers of adsTools.ts, which the MCP server shares.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { aiWriteDecision, oneLine } from '../core/adswatch';
import { COPILOT_NAMES } from '../core/adsToolText';
import { WriteInput as WriteInputOf, parseWriteInput, writeKey } from '../core/toolInput';
import { prepareWrite } from '../core/writeCall';
import { WriteItem, confirmMessage } from '../core/writeText';
import { parseCaptureInput, parseConfigInput, parseLogInput, parsePresetInput, parseScopeInput, parseWaitInput, parseWatchInput } from '../core/toolInput';
import { lmToolEntries } from '../core/lmToolTable';
import { PreparedWrites, WriteGate, WriteOp, itemsOf, writeResultText } from '../core/writeGate';
import { writePolicyReason } from '../core/writePolicy';
import { sendToAiChat } from '../commands/aiChat';
import { autoNote, clampAutoMinutes } from '../core/writeArming';
import { aiWritePathsSetting, aiWriteState, aiWritesSetting, setAiWrites } from './aiSettings';
import { SCOPE_SECONDS, adsTools, newest, scopeSummary } from './adsTools';

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

interface WriteInput { symbol?: string; value?: string; pulseMs?: number; writes?: { symbol: string; value: string; pulseMs?: number }[]; journal?: boolean; restore?: boolean; confirmPersistent?: boolean }
type SymbolsInput = Parameters<ReturnType<typeof adsTools>['symbols']>[0];
type WatchInput = Parameters<ReturnType<typeof adsTools>['watch']>[0];
type ReadInput = Parameters<ReturnType<typeof adsTools>['read']>[0];
type ScopeInput = Parameters<ReturnType<typeof adsTools>['scope']>[0];
type WaitToolInput = { symbol: string; condition: string; timeoutSeconds?: number };

/** Copilot's confirmation has no time limit, so this allows for a slow answer; the gate checks decision and target again at send time. */
const WRITE_PREPARE_MAX_AGE_MS = 900_000;

export function registerAdsLmTools(ctx: vscode.ExtensionContext, state: WorkspaceState, gate: WriteGate) {
  const tools = adsTools(ctx, state, COPILOT_NAMES);
  const host = tools.host;

  const symbolsTool: vscode.LanguageModelTool<SymbolsInput> = {
    async invoke(opts) { return text((await tools.symbols(opts.input)).text); },
  };

  const watchTool: vscode.LanguageModelTool<WatchInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Updating the ADS watch list' }),
    async invoke(opts, token) {
      const parsed = parseWatchInput(opts.input);
      if (!parsed.ok) return text(`Invalid arguments: ${parsed.error}`);
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return text((await tools.watch(parsed.value, abort.signal)).text);
      } finally {
        cancelled.dispose();
      }
    },
  };

  const readTool: vscode.LanguageModelTool<ReadInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading ADS values' }),
    async invoke(opts) { return text((await tools.read(opts.input)).text); },
  };

  const scopeTool: vscode.LanguageModelTool<ScopeInput> = {
    invoke(opts) {
      const p = parseScopeInput(opts.input);
      return text(p.ok ? tools.scope(p.value).text : `Invalid arguments: ${p.error}`);
    },
  };

  const captureTool: vscode.LanguageModelTool<{ symbol: string; condition: string; preSeconds?: number; postSeconds?: number; timeoutSeconds?: number; symbols?: string[] }> = {
    prepareInvocation: () => ({ invocationMessage: 'Capturing the ADS values around a condition' }),
    async invoke(opts, token) {
      const parsed = parseCaptureInput(opts.input);
      if (!parsed.ok) return text(`Invalid arguments: ${parsed.error}`);
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return text((await tools.capture(parsed.value, abort.signal)).text);
      } finally {
        cancelled.dispose();
      }
    },
  };

  const presetTool: vscode.LanguageModelTool<{ path?: string; preset?: string }> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading an ADS preset' }),
    async invoke(opts) {
      const parsed = parsePresetInput(opts.input);
      return text(parsed.ok ? (await tools.preset(parsed.value)).text : `Invalid arguments: ${parsed.error}`);
    },
  };

  const logTool: vscode.LanguageModelTool<{ mark?: boolean; since?: string; filter?: string[]; exclude?: string[]; maxLines?: number }> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading the TwinCAT log' }),
    async invoke(opts) {
      const parsed = parseLogInput(opts.input);
      return text(parsed.ok ? (await tools.log(parsed.value)).text : `Invalid arguments: ${parsed.error}`);
    },
  };

  const configTool: vscode.LanguageModelTool<{ pollMs?: number; bufferSeconds?: number }> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading or changing the ADS sampling' }),
    async invoke(opts, token) {
      const parsed = parseConfigInput(opts.input);
      if (!parsed.ok) return text(`Invalid arguments: ${parsed.error}`);
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return text((await tools.config(parsed.value, abort.signal)).text);
      } finally {
        cancelled.dispose();
      }
    },
  };

  const waitTool: vscode.LanguageModelTool<WaitToolInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Waiting for an ADS condition' }),
    async invoke(opts, token) {
      const parsed = parseWaitInput(opts.input);
      if (!parsed.ok) return text(`Invalid arguments: ${parsed.error}`);
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return text((await tools.wait(parsed.value, abort.signal)).text);
      } finally {
        cancelled.dispose();
      }
    },
  };

  // The decision and target each prepared write was shown with; the gate checks them against the settings at send time.
  const prepared = new PreparedWrites(WRITE_PREPARE_MAX_AGE_MS);

  /** The key a prepared confirmation is stored under: a restore also keys the plan it showed, so a changed journal is noticed. */
  const preparedKey = (input: WriteInputOf, items: readonly WriteItem[]): string => ('restore' in input ? `${writeKey(input)}${JSON.stringify(items.map(i => [i.symbol, i.value]))}` : writeKey(input));
  const writeDeps = { targetKey: () => host.targetKey(), requires: tools.requires, journal: tools.journal, restorePlan: tools.restorePlan, persistentOf: tools.persistentOf };

  const writeTool: vscode.LanguageModelTool<WriteInput> = {
    async prepareInvocation(opts) {
      const parsed = parseWriteInput(opts.input);
      // an invalid call never opens a confirmation; invoke answers with the reason
      if (!parsed.ok) return { invocationMessage: 'Not writing: invalid arguments' };
      if ('journal' in parsed.value) return { invocationMessage: 'Reading the write journal' };
      // outside the allowed paths the gate refuses without a dialog; asking the user first would be pointless. A batch on a
      // CLI that is too old, a write to persistent data without confirmPersistent and an empty restore are refused the same way.
      const call = await prepareWrite(parsed.value, 'Copilot', writeDeps);
      if ('text' in call) return { invocationMessage: `Not writing: ${show(call.text.text.split('\n')[0])}` };
      const items = itemsOf(call.op);
      if (writePolicyReason(items.map(i => i.symbol), { allowedPaths: aiWritePathsSetting() }) !== undefined) {
        return { invocationMessage: 'Not writing: outside the allowed paths' };
      }
      const summary = call.op.restore ? `restoring ${items.length} value${items.length === 1 ? '' : 's'}` : items.length === 1 ? `${show(items[0].symbol)} := ${show(items[0].value)}` : `${items.length} values`;
      const w = aiWriteState();
      const decision = aiWriteDecision(w.effective, w.redirected);
      prepared.prepare(preparedKey(parsed.value, items), { decision, targetKey: host.targetKey() });
      if (decision !== 'confirm') return { invocationMessage: decision === 'allow' ? `Writing ${summary}` : undefined };
      const note = autoNote(w.auto, w.redirected);
      return {
        invocationMessage: `Writing ${summary}`,
        confirmationMessages: {
          title: call.op.restore ? 'Restore PLC variables' : items.length === 1 ? 'Write PLC variable' : 'Write PLC variables',
          message: confirmMessage(items, host.target(), note, { restore: call.op.restore !== undefined, persistent: call.op.persistent }),
        },
      };
    },
    async invoke(opts, token) {
      const parsed = parseWriteInput(opts.input);
      if (!parsed.ok) return text(`Invalid arguments: ${parsed.error}`);
      const call = await prepareWrite(parsed.value, 'Copilot', writeDeps);
      if ('text' in call) return text(call.text.text);
      const op: WriteOp = call.op;
      // the confirmation Copilot showed in prepareInvocation; none (or an ambiguous one) makes the gate refuse
      const record = prepared.take(preparedKey(parsed.value, itemsOf(op)));
      if (op.restore && !record) return text('Not written: the journal changed after the confirmation was shown; call restore again.');
      op.targetKey = record?.targetKey ?? op.targetKey;
      if (record) op.prepared = { decision: record.decision };
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      try {
        return text(writeResultText(await gate.run(op, abort.signal), op));
      } finally {
        cancelled.dispose();
      }
    },
  };

  ctx.subscriptions.push(
    // one handler per tool the manifest declares (the table type and a test keep both lists in step)
    ...lmToolEntries<vscode.LanguageModelTool<any>>({
      iecode_ads_symbols: symbolsTool, iecode_ads_watch: watchTool, iecode_ads_read: readTool,
      iecode_ads_scope: scopeTool, iecode_ads_write: writeTool, iecode_ads_wait: waitTool, iecode_ads_config: configTool, iecode_ads_preset: presetTool, iecode_ads_capture: captureTool, iecode_ads_log: logTool,
    }).map(([name, tool]) => vscode.lm.registerTool(name, tool)),
    vscode.commands.registerCommand('iecode.adsWatchAiChat', async () => {
      const symbols = host.watched();
      if (!symbols.length) return vscode.window.showInformationMessage('IECode: the ADS watch list is empty, nothing to send.');
      if (newest(host, symbols) === undefined) return vscode.window.showInformationMessage('IECode: no ADS samples yet, nothing to send. Values are sampled while the ADS Watch view or the scope is open.');
      await sendToAiChat(scopeSummary(host, symbols, SCOPE_SECONDS));
    }),
    vscode.commands.registerCommand('iecode.adsAiWrites', async () => {
      const current = aiWritesSetting();
      const w = aiWriteState();
      const minutes = clampAutoMinutes(vscode.workspace.getConfiguration('iecode.ads').inspect<unknown>('aiWritesAutoMinutes')?.globalValue);
      const picks: (vscode.QuickPickItem & { value: string })[] = [
        { value: 'off', label: 'Off', detail: 'AI tools cannot write PLC variables.' },
        { value: 'confirm', label: 'Confirm each write', detail: 'You confirm every AI write (in Copilot Chat unless you chose "Always Allow" for the ADS Write tool).' },
        { value: 'auto', label: 'Auto-approve', detail: `IECode writes without asking; VS Code may still ask by its own tool approval rules. Lasts ${minutes} min, then each write is confirmed again.` },
      ];
      for (const p of picks) {
        if (p.value !== current) continue;
        p.description = w.auto.kind === 'armed' ? `(current, ${Math.ceil(w.auto.leftMs / 60_000)} min left)`
          : w.auto.kind === 'expired' ? '(current, expired)' : w.auto.kind === 'notArmed' ? '(current, not armed)' : '(current)';
      }
      const pick = await vscode.window.showQuickPick(picks, { title: 'AI write access to the PLC (iecode.ads.aiWrites)' });
      if (pick) await setAiWrites(pick.value as 'off' | 'confirm' | 'auto');
    }),
  );
}
