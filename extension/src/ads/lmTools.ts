// Language model tools (Copilot Chat agent mode) on the ADS host: list symbols, edit the watch list, read values,
// summarize the sample buffer, and write per iecode.ads.aiWrites. Plus "Add to AI Chat" for the watch view and the
// AI write access picker. The read-only tools are thin wrappers of adsTools.ts, which the MCP server shares.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { aiWriteDecision, oneLine } from '../core/adswatch';
import { COPILOT_NAMES } from '../core/adsToolText';
import { parseScopeInput, parseWaitInput, parseWatchInput } from '../core/toolInput';
import { lmToolEntries } from '../core/lmToolTable';
import { PreparedWrites, WriteGate, WriteOp, writeResultText } from '../core/writeGate';
import { writePolicyReason } from '../core/writePolicy';
import { sendToAiChat } from '../commands/aiChat';
import { aiWritePathsSetting, aiWritesSetting, workspaceTarget } from './aiSettings';
import { SCOPE_SECONDS, adsTools, newest, scopeSummary } from './adsTools';

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

interface WriteInput { symbol: string; value: string }
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
  const writeKey = (input: WriteInput) => JSON.stringify([input.symbol, input.value]);

  const writeTool: vscode.LanguageModelTool<WriteInput> = {
    prepareInvocation(opts) {
      const symbol = show(opts.input.symbol), value = show(opts.input.value);
      // outside the allowed paths the gate refuses without a dialog; asking the user first would be pointless
      if (writePolicyReason([opts.input.symbol], { allowedPaths: aiWritePathsSetting() }) !== undefined) {
        return { invocationMessage: 'Not writing: outside the allowed paths' };
      }
      const setting = aiWritesSetting();
      const redirected = workspaceTarget();
      const decision = aiWriteDecision(setting, redirected);
      prepared.prepare(writeKey(opts.input), { decision, targetKey: host.targetKey() });
      if (decision !== 'confirm') return { invocationMessage: decision === 'allow' ? `Writing ${symbol} := ${value}` : undefined };
      const note = setting === 'auto' && redirected ? ' (the workspace settings set the ADS target or port, so auto-approve does not apply)' : '';
      return {
        invocationMessage: `Writing ${symbol} := ${value}`,
        confirmationMessages: { title: 'Write PLC variable', message: `Write ${symbol} := ${value} on ${host.target()}?${note}` },
      };
    },
    async invoke(opts, token) {
      const { symbol, value } = opts.input;
      // the confirmation Copilot showed in prepareInvocation; none (or an ambiguous one) makes the gate refuse
      const record = prepared.take(writeKey(opts.input));
      const op: WriteOp = { symbol, value, targetKey: record?.targetKey ?? host.targetKey(), via: 'Copilot', prepared: record && { decision: record.decision } };
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
      iecode_ads_scope: scopeTool, iecode_ads_write: writeTool, iecode_ads_wait: waitTool,
    }).map(([name, tool]) => vscode.lm.registerTool(name, tool)),
    vscode.commands.registerCommand('iecode.adsWatchAiChat', async () => {
      const symbols = host.watched();
      if (!symbols.length) return vscode.window.showInformationMessage('IECode: the ADS watch list is empty, nothing to send.');
      if (newest(host, symbols) === undefined) return vscode.window.showInformationMessage('IECode: no ADS samples yet, nothing to send. Values are sampled while the ADS Watch view or the scope is open.');
      await sendToAiChat(scopeSummary(host, symbols, SCOPE_SECONDS));
    }),
    vscode.commands.registerCommand('iecode.adsAiWrites', async () => {
      const current = aiWritesSetting();
      const picks: (vscode.QuickPickItem & { value: string })[] = [
        { value: 'off', label: 'Off', detail: 'AI tools cannot write PLC variables.' },
        { value: 'confirm', label: 'Confirm each write', detail: 'You confirm every AI write (in Copilot Chat unless you chose "Always Allow" for the ADS Write tool).' },
        { value: 'auto', label: 'Auto-approve', detail: 'IECode writes without asking; VS Code may still ask by its own tool approval rules.' },
      ];
      for (const p of picks) if (p.value === current) p.description = '(current)';
      const pick = await vscode.window.showQuickPick(picks, { title: 'AI write access to the PLC (iecode.ads.aiWrites)' });
      if (pick) await vscode.workspace.getConfiguration('iecode.ads').update('aiWrites', pick.value, vscode.ConfigurationTarget.Global);
    }),
  );
}
