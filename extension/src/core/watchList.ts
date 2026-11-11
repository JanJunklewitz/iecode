// The single owner of the ADS watch list: every edit (AI, user, wait hold) runs as one step on one promise chain and
// reads the list when the step runs, so concurrent callers never overwrite each other's entries. No vscode imports.

import { WatchEntry, watchEdit, watchLimitError } from './adswatch';

export interface WatchListDeps { entries(): WatchEntry[]; set(entries: WatchEntry[]): Promise<unknown> }

export interface WaitHold { readonly symbol: string; release(): Promise<void> }

/** Holds of one symbol (case-insensitive key); `added` is true while the last release should remove the entry. */
interface HoldRecord { symbol: string; tokens: Set<object>; added: boolean }

const key = (s: string): string => s.trim().toLowerCase();

/** What one AI edit did, per requested name (trimmed, de-duplicated case-insensitively). */
export interface AiEditResult {
  added: string[];
  already: string[];
  removed: string[];
  kept: string[];
  held: string[];
  missing: string[];
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names.map(x => x.trim())) {
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

export class WatchList {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly holds = new Map<string, HoldRecord>();
  private readonly listeners = new Set<(symbols: string[]) => void>();

  constructor(private readonly deps: WatchListDeps) {}

  /** AI add/remove (ads_watch). Says what was added, already there, removed, refused (user's entry), postponed (wait) or unknown. */
  aiEdit(add: string[], remove: string[]): Promise<AiEditResult> {
    return this.step(async () => {
      const current = this.deps.entries();
      const result: AiEditResult = { added: [], already: [], removed: [], kept: [], held: [], missing: [] };
      for (const a of uniqueNames(add)) (current.some(e => key(e.symbol) === key(a)) ? result.already : result.added).push(a);
      for (const r of uniqueNames(remove)) {
        const entry = current.find(e => key(e.symbol) === key(r));
        if (!entry) result.missing.push(r);
        else if (!entry.ai) result.kept.push(r);
        else if (this.held(key(r))) result.held.push(r);
        else result.removed.push(r);
      }
      // a held entry stays until its last hold releases; only the removal of what a hold needs is postponed
      const postponed = remove.filter(r => this.held(key(r)));
      const next = watchEdit(watchEdit(current, add, [], true), [], remove.filter(r => !this.held(key(r))), true);
      await this.deps.set(next);
      for (const a of add) { const rec = this.holds.get(key(a)); if (rec) rec.added = false; }
      for (const r of postponed) {
        const rec = this.holds.get(key(r));
        if (rec && current.some(e => e.ai && e.symbol.toLowerCase() === key(r))) rec.added = true;
      }
      return result;
    });
  }

  /** Any user edit: `edit` maps the current entries to the next ones (watchEdit, watchRename, filter, []). */
  userEdit(edit: (current: WatchEntry[]) => WatchEntry[]): Promise<void> {
    return this.step(async () => {
      const next = edit(this.deps.entries());
      // `set` may throw after the list was saved (host start), so the holds follow `next` either way
      const failed = await this.deps.set(next).then(() => undefined, (e: unknown) => ({ e }));
      const left = new Set(next.map(e => key(e.symbol)));
      const removed: string[] = [];
      for (const [k, rec] of this.holds) if (!left.has(k)) { removed.push(rec.symbol); this.holds.delete(k); }
      if (removed.length) {
        for (const l of [...this.listeners]) {
          try { l(removed); } catch { /* a listener must not fail an edit that is already saved */ }
        }
      }
      if (failed) throw failed.e;
    });
  }

  /** Keeps the symbol watched for a wait; adds it as an AI entry when missing. */
  hold(symbol: string): Promise<WaitHold> {
    return this.step(async () => {
      const name = symbol.trim();
      const k = key(name);
      const current = this.deps.entries();
      const present = current.some(e => e.symbol.toLowerCase() === k);
      if (!present) {
        const next = [...current, { symbol: name, ai: true }];
        const tooMany = watchLimitError(next.length);
        if (tooMany) throw new Error(tooMany);
        try {
          await this.deps.set(next);
        } catch (e) {
          // the refused wait never releases: take back the entry it may have saved, unless another hold needs it
          if (!this.held(k)) {
            const after = this.deps.entries();
            if (after.some(x => x.ai && x.symbol.toLowerCase() === k)) {
              await this.deps.set(after.filter(x => x.symbol.toLowerCase() !== k)).catch(() => undefined);
            }
          }
          throw e;
        }
      }
      let rec = this.holds.get(k);
      if (!rec) this.holds.set(k, rec = { symbol: name, tokens: new Set(), added: false });
      if (!present) rec.added = true;
      const token = {};
      rec.tokens.add(token);
      return { symbol: name, release: () => this.release(k, token) };
    });
  }

  /** Fires with the symbols (as held) a user edit removed while a wait held them. */
  onUserRemoved(listener: (symbols: string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  // Idempotent: a token already released, or dropped by a user edit, changes nothing.
  private release(k: string, token: object): Promise<void> {
    return this.step(async () => {
      const rec = this.holds.get(k);
      if (!rec?.tokens.has(token)) return;
      // the token goes even when `set` throws (it may have saved): the list keeps whatever was saved, no retry
      try {
        if (rec.tokens.size === 1 && rec.added) {
          const current = this.deps.entries();
          // the user taking the entry over (ai = false) keeps it
          if (current.some(e => e.ai && e.symbol.toLowerCase() === k)) {
            await this.deps.set(current.filter(e => e.symbol.toLowerCase() !== k));
          }
        }
      } finally {
        rec.tokens.delete(token);
        if (!rec.tokens.size) this.holds.delete(k);
      }
    });
  }

  private held(k: string): boolean {
    return (this.holds.get(k)?.tokens.size ?? 0) > 0;
  }

  // A failed step rejects only its own call; the chain goes on with the next one.
  private step<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
