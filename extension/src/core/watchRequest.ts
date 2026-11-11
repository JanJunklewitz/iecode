// One ads_watch call: the optional confirmation to remove the user's own entries, then one edit of the list. The dialog is
// injected (no vscode here) and is asked before the edit, never inside the list's step chain, so an open dialog cannot
// block other edits.

import type { AiEditResult, WatchList } from './watchList';
import type { WatchRequest } from './toolInput';

/** Asks the user once to remove these entries they added; true = yes. */
export type ConfirmUserRemoval = (symbols: string[], signal: AbortSignal) => Promise<boolean>;

export interface GroupOp { name: string; action: 'on' | 'off' | 'removed' | 'none'; members: number }

export interface WatchRunResult extends AiEditResult { declined: string[]; groupOp?: GroupOp }

export async function runWatchRequest(list: WatchList, req: WatchRequest, confirm: ConfirmUserRemoval, signal: AbortSignal): Promise<WatchRunResult> {
  if (req.removeGroup && req.group !== undefined) {
    const g = await list.removeGroup(req.group);
    return {
      added: [], already: [], removed: g.removed, kept: [], held: g.held, missing: [], declined: [],
      groupOp: { name: req.group, action: g.found ? 'removed' : 'none', members: g.removed.length + g.held.length },
    };
  }
  let removeUser: string[] = [];
  let declined: string[] = [];
  if (req.force && req.remove.length) {
    const owned = list.userOwned(req.remove);
    if (owned.length) {
      let yes = false;
      try { yes = await confirm(owned, signal); } catch { yes = false; }
      if (yes) removeUser = owned; else declined = owned;
    }
  }
  const withAdd = req.add.length > 0 && req.group !== undefined;
  const r = await list.aiEdit(req.add, req.remove, { removeUser, clearAi: req.clearAi, group: req.group, enable: withAdd ? req.enable : undefined, signal });
  const refused = new Set(declined.map(d => d.toLowerCase()));
  const out: WatchRunResult = { ...r, kept: r.kept.filter(k => !refused.has(k.toLowerCase())), declined };
  if (withAdd && req.enable !== undefined && req.group !== undefined) {
    out.groupOp = { name: req.group, action: req.enable ? 'on' : 'off', members: r.groupMembers ?? 0 };
  } else if (req.enable !== undefined && req.group !== undefined) {
    const g = await list.setGroup(req.group, req.enable);
    out.groupOp = { name: req.group, action: g.found ? (req.enable ? 'on' : 'off') : 'none', members: g.members };
  }
  return out;
}
