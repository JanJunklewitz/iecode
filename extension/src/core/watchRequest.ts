// One ads_watch call: the optional confirmation to remove the user's own entries, then one edit of the list. The dialog is
// injected (no vscode here) and is asked before the edit, never inside the list's step chain, so an open dialog cannot
// block other edits.

import type { AiEditResult, WatchList } from './watchList';
import type { WatchRequest } from './toolInput';

/** Asks the user once to remove these entries they added; true = yes. */
export type ConfirmUserRemoval = (symbols: string[], signal: AbortSignal) => Promise<boolean>;

export interface WatchRunResult extends AiEditResult { declined: string[] }

export async function runWatchRequest(list: WatchList, req: WatchRequest, confirm: ConfirmUserRemoval, signal: AbortSignal): Promise<WatchRunResult> {
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
  const r = await list.aiEdit(req.add, req.remove, { removeUser, clearAi: req.clearAi });
  const refused = new Set(declined.map(d => d.toLowerCase()));
  return { ...r, kept: r.kept.filter(k => !refused.has(k.toLowerCase())), declined };
}
