// The single owner of the ADS watch list: every edit (AI, user, wait hold) runs as one step on one promise chain and
// reads the list when the step runs, so concurrent callers never overwrite each other's entries. No vscode imports.

import { WatchEntry, watchEdit, watchLimitError } from './adswatch';
import { activeSymbols, addToGroup, dropGroup, groupKey, isActive } from './watchGroups';

export interface WatchListDeps {
  entries(): WatchEntry[];
  /** Saves the list; `active` are the symbols to sample (the list minus switched-off groups, plus held symbols). */
  set(entries: WatchEntry[], active: string[]): Promise<unknown>;
  /** Keys (`groupKey`) of the switched-off groups. */
  groupsOff(): string[];
  setGroupsOff(keys: string[]): Promise<unknown>;
}

export interface WaitHold { readonly symbol: string; release(): Promise<void> }

/** Holds of one symbol (case-insensitive key); `added` is true while the last release should remove the entry. */
interface HoldRecord { symbol: string; tokens: Set<object>; added: boolean }

const key = (s: string): string => s.trim().toLowerCase();

/** What one AI edit did, per requested name (trimmed, de-duplicated case-insensitively). The group fields are set only for an edit with a group. */
export interface AiEditResult {
  added: string[];
  already: string[];
  removed: string[];
  kept: string[];
  held: string[];
  missing: string[];
  grouped?: string[];
  ungrouped?: string[];
  switchedOn?: boolean;
}

export interface AiEditOptions {
  /** Symbols the user confirmed to remove although they added them. Only these user entries may go. */
  removeUser?: string[];
  /** Remove every AI entry that no wait holds. */
  clearAi?: boolean;
  /** Label the added (and already present AI) symbols with this group; a switched-off group is switched on. */
  group?: string;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names.map(x => x.trim())) {
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

const hasGroup = (e: WatchEntry, k: string): boolean => !!e.groups?.some(g => groupKey(g) === k);

export class WatchList {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly holds = new Map<string, HoldRecord>();
  private readonly listeners = new Set<(symbols: string[]) => void>();

  constructor(private readonly deps: WatchListDeps) {}

  /** AI add/remove (ads_watch). Says what was added, already there, removed, refused (user's entry), postponed (wait) or unknown. */
  aiEdit(add: string[], remove: string[], opts: AiEditOptions = {}): Promise<AiEditResult> {
    return this.step(async () => {
      const current = this.deps.entries();
      const confirmed = new Set((opts.removeUser ?? []).map(key));
      const result: AiEditResult = { added: [], already: [], removed: [], kept: [], held: [], missing: [] };
      for (const a of uniqueNames(add)) (current.some(e => key(e.symbol) === key(a)) ? result.already : result.added).push(a);
      const asked = opts.clearAi ? current.filter(e => e.ai).map(e => e.symbol) : uniqueNames(remove);
      const drop = new Set<string>();
      const postponed: string[] = [];
      for (const r of asked) {
        const entry = current.find(e => key(e.symbol) === key(r));
        if (!entry) result.missing.push(r);
        else if (!entry.ai && !confirmed.has(key(r))) result.kept.push(r);
        else if (this.held(key(r))) { result.held.push(r); if (entry.ai) postponed.push(r); }
        else { result.removed.push(r); drop.add(key(r)); }
      }
      // a held entry stays until its last hold releases; only the removal of what a hold needs is postponed
      let next = watchEdit(current, add, [], true).filter(e => !drop.has(key(e.symbol)));
      let off = this.deps.groupsOff();
      if (opts.group !== undefined) {
        const g = addToGroup(next, uniqueNames(add), opts.group);
        next = g.entries;
        result.grouped = g.grouped;
        result.ungrouped = g.refused;
        const k = groupKey(opts.group);
        result.switchedOn = off.includes(k) && g.grouped.length > 0;
        if (result.switchedOn) off = off.filter(x => x !== k);
      }
      await this.save(next, off);
      for (const a of add) { const rec = this.holds.get(key(a)); if (rec) rec.added = false; }
      for (const r of postponed) { const rec = this.holds.get(key(r)); if (rec) rec.added = true; }
      return result;
    });
  }

  /** The requested symbols (requested spelling) that are entries the user added; reads the list now, outside the step chain. */
  userOwned(symbols: string[]): string[] {
    const current = this.deps.entries();
    return uniqueNames(symbols).filter(n => current.some(e => !e.ai && key(e.symbol) === key(n)));
  }

  /** Switches a group on or off. Off: its entries stay in the list but are not sampled (unless a wait holds them or another group is on). */
  setGroup(name: string, enabled: boolean): Promise<{ found: boolean; members: number }> {
    return this.step(async () => {
      const current = this.deps.entries();
      const k = groupKey(name);
      const members = current.filter(e => hasGroup(e, k)).length;
      if (!members) return { found: false, members: 0 };
      const off = this.deps.groupsOff().filter(x => x !== k);
      if (!enabled) off.push(k);
      await this.save(current, off);
      return { found: true, members };
    });
  }

  /** Removes the group: entries no other group needs go, except the ones a wait holds (they lose the label and are reported in `held`). */
  removeGroup(name: string): Promise<{ found: boolean; removed: string[]; held: string[] }> {
    return this.step(async () => {
      const current = this.deps.entries();
      const k = groupKey(name);
      if (!current.some(e => hasGroup(e, k))) return { found: false, removed: [], held: [] };
      const dropped = dropGroup(current, name);
      const held = dropped.removed.filter(s => this.held(key(s)));
      const removed = dropped.removed.filter(s => !this.held(key(s)));
      const next: WatchEntry[] = [];
      for (const e of current) {
        if (!hasGroup(e, k)) next.push(e);
        else if (held.includes(e.symbol)) next.push({ symbol: e.symbol, ai: e.ai });
        else { const kept = dropped.entries.find(x => x.symbol === e.symbol); if (kept) next.push(kept); }
      }
      await this.save(next, this.deps.groupsOff().filter(x => x !== k));
      return { found: true, removed, held };
    });
  }

  /** 'none' when no entry has the group. */
  groupState(name: string): 'on' | 'off' | 'none' {
    const k = groupKey(name);
    if (!this.deps.entries().some(e => hasGroup(e, k))) return 'none';
    return this.deps.groupsOff().includes(k) ? 'off' : 'on';
  }

  /** Any user edit: `edit` maps the current entries to the next ones (watchEdit, watchRename, filter, []). */
  userEdit(edit: (current: WatchEntry[]) => WatchEntry[]): Promise<void> {
    return this.step(async () => {
      const next = edit(this.deps.entries());
      // `set` may throw after the list was saved (host start), so the holds follow `next` either way
      const failed = await this.save(next).then(() => undefined, (e: unknown) => ({ e }));
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

  /** Keeps the symbol watched for a wait; adds it as an AI entry when missing, and samples it while its groups are off. */
  hold(symbol: string): Promise<WaitHold> {
    return this.step(async () => {
      const name = symbol.trim();
      const k = key(name);
      const current = this.deps.entries();
      const entry = current.find(e => key(e.symbol) === k);
      let rec = this.holds.get(k);
      if (!rec) this.holds.set(k, rec = { symbol: name, tokens: new Set(), added: false });
      const token = {};
      rec.tokens.add(token);
      const record = rec;
      try {
        if (!entry) {
          await this.save([...current, { symbol: name, ai: true }]);
          record.added = true;
        } else if (!isActive(entry, this.deps.groupsOff())) {
          await this.save(current);
        }
      } catch (e) {
        // the refused wait never releases: drop its token and take back the entry it may have saved, unless another hold needs it
        record.tokens.delete(token);
        if (!record.tokens.size) this.holds.delete(k);
        if (!entry && !this.held(k)) {
          const after = this.deps.entries();
          if (after.some(x => x.ai && key(x.symbol) === k)) {
            await this.save(after.filter(x => key(x.symbol) !== k)).catch(() => undefined);
          }
        }
        throw e;
      }
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
      // the token goes even when `save` throws (it may have saved): the list keeps whatever was saved, no retry
      const last = rec.tokens.size === 1;
      const added = rec.added;
      rec.tokens.delete(token);
      if (!rec.tokens.size) this.holds.delete(k);
      if (!last) return;
      const current = this.deps.entries();
      const entry = current.find(e => key(e.symbol) === k);
      if (added) {
        // the user taking the entry over (ai = false) keeps it
        if (entry?.ai) await this.save(current.filter(e => key(e.symbol) !== k));
      } else if (entry && !isActive(entry, this.deps.groupsOff())) {
        // its groups are off again: stop sampling it
        await this.save(current);
      }
    });
  }

  private held(k: string): boolean {
    return (this.holds.get(k)?.tokens.size ?? 0) > 0;
  }

  private heldSymbols(): string[] {
    return [...this.holds.values()].filter(r => r.tokens.size > 0).map(r => r.symbol);
  }

  /** Every write of the list: computes the sampled list, refuses an over-limit one before anything is written, then saves. */
  private async save(next: WatchEntry[], off: string[] = this.deps.groupsOff()): Promise<void> {
    const active = activeSymbols(next, off, this.heldSymbols());
    const tooMany = watchLimitError(active.length);
    if (tooMany) throw new Error(tooMany);
    const before = this.deps.groupsOff();
    if (off.length !== before.length || off.some((x, i) => x !== before[i])) await this.deps.setGroupsOff(off);
    await this.deps.set(next, active);
  }

  // A failed step rejects only its own call; the chain goes on with the next one.
  private step<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
