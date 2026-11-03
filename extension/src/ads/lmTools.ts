// Language model tools (Copilot Chat agent mode) on the ADS host: list symbols, edit the watch list, read values,
// summarize the sample buffer, and write per iecode.ads.aiWrites. Plus "Add to AI Chat" for the watch view and the
// AI write access picker. The read-only tools are thin wrappers of adsTools.ts, which the MCP server shares.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { WriteDecision, aiWriteDecision, oneLine, writeStillApproved } from '../core/adswatch';
import { COPILOT_NAMES } from '../core/adsToolText';
import { output } from '../cli/iecode';
import { sendToAiChat } from '../commands/aiChat';
import { aiWritesSetting, workspaceTarget } from './aiSettings';
import { SCOPE_SECONDS, adsTools, errorText, newest, scopeSummary } from './adsTools';

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

const failure = (e: unknown) => text(errorText(e));

interface WriteInput { symbol: string; value: string }
type SymbolsInput = Parameters<ReturnType<typeof adsTools>['symbols']>[0];
type WatchInput = Parameters<ReturnType<typeof adsTools>['watch']>[0];
type ReadInput = Parameters<ReturnType<typeof adsTools>['read']>[0];
type ScopeInput = Parameters<ReturnType<typeof adsTools>['scope']>[0];

export function registerAdsLmTools(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const tools = adsTools(ctx, state, COPILOT_NAMES);
  const host = tools.host;

  const symbolsTool: vscode.LanguageModelTool<SymbolsInput> = {
    async invoke(opts) { return text((await tools.symbols(opts.input)).text); },
  };

  const watchTool: vscode.LanguageModelTool<WatchInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Updating the ADS watch list' }),
    async invoke(opts) { return text((await tools.watch(opts.input)).text); },
  };

  const readTool: vscode.LanguageModelTool<ReadInput> = {
    prepareInvocation: () => ({ invocationMessage: 'Reading ADS values' }),
    async invoke(opts) { return text((await tools.read(opts.input)).text); },
  };

  const scopeTool: vscode.LanguageModelTool<ScopeInput> = {
    invoke(opts) { return text(tools.scope(opts.input).text); },
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
      if (newest(host, symbols) === undefined) return vscode.window.showInformationMessage('IECode: no ADS samples yet, nothing to send. Values are sampled while the ADS Watch view or the scope is open.');
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
