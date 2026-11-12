// VS Code side of the write gate (core/writeGate.ts): the confirmation dialog, the settings and the ADS host.
// One gate per window serves every AI client, so two writes never overlap and every one is bound to the target the
// user confirmed.

import * as vscode from 'vscode';
import { aiWriteDecision, oneLine } from '../core/adswatch';
import { GatePolicy, WriteGate, WriteOp, WriteResult, itemsOf, sendOutcome } from '../core/writeGate';
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
        confirmMessage(itemsOf(op), `${op.targetKey} (${workspaceName()})`, note), { modal: true }, 'Write');
      return pick === 'Write';
    },

    async send(op, beforeSend): Promise<WriteResult> {
      try {
        const back = await host.write(op.symbol, op.value, () => {
          const why = beforeSend();
          if (why === undefined) output.info(`AI write ${show(op.symbol)} := ${show(op.value)} on ${op.targetKey} via ${op.via}`);
          return why;
        });
        return { kind: 'written', readBack: back.value, readBackError: back.readBackError };
      } catch (e) {
        output.warn(`AI write ${show(op.symbol)} via ${op.via} did not complete: ${show((e as Error).message)}`);
        return sendOutcome(e);
      }
    },

    lateApproval(op, reason) {
      void vscode.window.showWarningMessage(`IECode: ${show(op.symbol)} was not written: ${reason}.`);
    },
  }, policy);
}
