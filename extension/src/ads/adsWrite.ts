// VS Code side of the write gate (core/writeGate.ts): the confirmation dialog, the settings and the ADS host.
// One gate per window serves every AI client, so two writes never overlap and every one is bound to the target the
// user confirmed.

import * as vscode from 'vscode';
import { aiWriteDecision, oneLine } from '../core/adswatch';
import { GatePolicy, WriteGate, WriteOp, WriteResult, itemsOf } from '../core/writeGate';
import { executeWrite } from '../core/writeExec';
import { writePolicyReason } from '../core/writePolicy';
import { confirmMessage } from '../core/writeText';
import { output } from '../cli/iecode';
import { aiWritePathsSetting, aiWritesSetting, workspaceTarget } from './aiSettings';
import { AdsHost } from './host';

/** AI-supplied symbol or value, safe for one log line or prompt. */
const show = (s: unknown) => oneLine(String(s));

export function adsWriteGate(host: AdsHost, workspaceName: () => string, policy: GatePolicy): WriteGate {
  return new WriteGate({
    decision: () => aiWriteDecision(aiWritesSetting(), workspaceTarget()),
    targetKey: () => host.targetKey(),
    policy: op => writePolicyReason(itemsOf(op).map(i => i.symbol), { allowedPaths: aiWritePathsSetting() }),

    // The raw choice: a modal cannot be closed from outside, so an answer after a cancellation still arrives here and
    // the gate decides what it means.
    async confirm(op: WriteOp): Promise<boolean> {
      const note = aiWritesSetting() === 'auto' && workspaceTarget()
        ? ' (the workspace settings set the ADS target or port, so auto-approve does not apply)' : '';
      const pick = await vscode.window.showWarningMessage(
        confirmMessage(itemsOf(op), `${op.targetKey} (${workspaceName()})`, note, { restore: op.restore !== undefined, persistent: op.persistent }), { modal: true }, 'Write');
      return pick === 'Write';
    },

    async send(op, beforeSend): Promise<WriteResult> {
      const items = itemsOf(op);
      const label = items.length === 1 ? show(items[0].symbol) : `batch of ${items.length}`;
      const logged = () => {
        const why = beforeSend();
        if (why === undefined) {
          output.info(items.length === 1
            ? `AI write ${show(items[0].symbol)} := ${show(items[0].value)} on ${op.targetKey} via ${op.via}`
            : `AI write batch of ${items.length} on ${op.targetKey} via ${op.via}: ${items.map(i => `${show(i.symbol)} := ${show(i.value)}`).join(', ')}`);
        }
        return why;
      };
      const result = await executeWrite(op, logged, {
        writeOne: (item, before) => host.write(item.symbol, item.value, before),
        writeMany: (list, before) => host.writeMany(list, before),
        journal: host.journal,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: () => performance.now(),
        targetKey: () => host.targetKey(),
        readBefore: async symbols => {
          try {
            return await host.read(symbols);
          } catch (e) {
            return symbols.map(symbol => ({ symbol, type: null, value: null, error: (e as Error).message }));
          }
        },
      });
      if (result.kind === 'refused' || result.kind === 'unknown') {
        output.warn(`AI write ${label} via ${op.via} did not complete: ${show(result.reason)}`);
      }
      return result;
    },

    lateApproval(op, reason) {
      void vscode.window.showWarningMessage(`IECode: ${show(op.symbol)} was not written: ${reason}.`);
    },
  }, policy);
}
