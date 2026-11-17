// From a parsed `ads_write` call to the op the gate runs, or to a text that needs no write at all (journal, nothing to
// restore, a refusal before any dialog). One module serves MCP and Copilot, so both refuse and describe the same way. Pure:
// the host-dependent parts (CLI features, journal, current values, persistent data) come in through WriteCallDeps.

import type { ToolText } from './adsToolText';
import type { WriteInput } from './toolInput';
import { WriteOp, featureOf, itemsOf, opOf } from './writeGate';
import { NOTHING_TO_RESTORE, RestorePlan, restoreFooter } from './writeJournal';
import { sentence } from './writeText';
import { persistentRefusal } from './writePolicy';

export interface WriteCallDeps {
  targetKey(): string;
  /** The "needs a newer iecode CLI" text when the host lacks a protocol feature, else undefined. */
  requires?(feature: string): Promise<string | undefined>;
  /** The text of the session journal (read-only). */
  journal?(): ToolText;
  /** The plan that undoes the journal; reads the current values of the journaled symbols. */
  restorePlan?(): Promise<RestorePlan>;
  /** The symbols (of those given) that lie in persistent data. */
  persistentOf?(symbols: string[]): Promise<string[]>;
}

export type PreparedCall = { text: ToolText } | { op: WriteOp };

const refused = (reason: string): { text: ToolText } => ({ text: { text: `Not written: ${sentence(reason)}.`, isError: true } });

export async function prepareWrite(input: WriteInput, via: WriteOp['via'], deps: WriteCallDeps, base: Pick<WriteOp, 'prepared'> = {}): Promise<PreparedCall> {
  if ('journal' in input) {
    return { text: deps.journal ? deps.journal() : { text: 'The journal is not available.', isError: true } };
  }
  const common = { targetKey: deps.targetKey(), via, ...base };
  let op: WriteOp;
  if ('restore' in input) {
    if (!deps.restorePlan) return { text: { text: 'Restore is not available.', isError: true } };
    const plan = await deps.restorePlan();
    if (!plan.writes.length) {
      const footer = restoreFooter(plan);
      return { text: { text: [NOTHING_TO_RESTORE(common.targetKey), ...(footer ? [footer] : [])].join('\n') } };
    }
    op = { symbol: plan.writes[0].symbol, value: plan.writes[0].value, items: plan.writes, restore: { skipped: plan.skipped, remaining: plan.remaining }, ...common };
  } else {
    op = opOf(input, common);
  }

  // An old CLI has no batch op: say so before any dialog opens.
  const need = featureOf(op);
  if (need && deps.requires) {
    const missing = await deps.requires(need);
    if (missing) return refused(missing);
  }

  if (deps.persistentOf) {
    const persistent = await deps.persistentOf(itemsOf(op).map(i => i.symbol));
    if (persistent.length) {
      if (!('confirmPersistent' in input && input.confirmPersistent)) return refused(persistentRefusal(persistent));
      op.persistent = persistent;
    }
  }
  return { op };
}
