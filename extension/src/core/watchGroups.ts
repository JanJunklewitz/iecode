// Named groups of AI watch entries. A group is a label on an entry (WatchEntry.groups), so the saved list needs no extra
// structure. Groups can be switched off: the entries then stay in the list but are not sampled. Pure: no vscode.

import type { WatchEntry } from './adswatch';

export const MAX_GROUP_LENGTH = 64;
export const MAX_GROUPS_PER_ENTRY = 8;
export const MAX_GROUPS_TOTAL = 50;

export const groupKey = (name: string): string => name.trim().toLowerCase();

export function groupNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'group must not be blank';
  if (n.length > MAX_GROUP_LENGTH) return `group is longer than ${MAX_GROUP_LENGTH} characters`;
  return undefined;
}

/** No group, or at least one group that is not switched off (`off` holds group keys). */
export function isActive(e: WatchEntry, off: readonly string[]): boolean {
  if (!e.groups?.length) return true;
  return e.groups.some(g => !off.includes(groupKey(g)));
}

/** The entries that are sampled: active ones, plus ones a running wait holds; the list order is kept. */
export function activeSymbols(entries: WatchEntry[], off: readonly string[], held: readonly string[]): string[] {
  const keep = new Set(held.map(h => h.trim().toLowerCase()));
  return entries.filter(e => isActive(e, off) || keep.has(e.symbol.toLowerCase())).map(e => e.symbol);
}

export interface GroupSummary { name: string; count: number; on: boolean }

/** Groups in order of first appearance; the name is the first spelling used. */
export function groupSummaries(entries: WatchEntry[], off: readonly string[]): GroupSummary[] {
  const byKey = new Map<string, GroupSummary>();
  for (const e of entries) {
    for (const g of e.groups ?? []) {
      const k = groupKey(g);
      const found = byKey.get(k);
      if (found) found.count++;
      else byKey.set(k, { name: g, count: 1, on: !off.includes(k) });
    }
  }
  return [...byKey.values()];
}

/** Labels AI entries with `group`. A user entry is refused (requested spelling); a symbol not in the list is ignored. */
export function addToGroup(current: WatchEntry[], symbols: string[], group: string): { entries: WatchEntry[]; grouped: string[]; refused: string[] } {
  const name = group.trim();
  const k = groupKey(name);
  const grouped: string[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  const entries = [...current];
  for (const raw of symbols) {
    const s = raw.trim();
    const sk = s.toLowerCase();
    if (!s || seen.has(sk)) continue;
    seen.add(sk);
    const at = entries.findIndex(e => e.symbol.toLowerCase() === sk);
    if (at < 0) continue;
    const entry = entries[at];
    if (!entry.ai) { refused.push(s); continue; }
    grouped.push(s);
    if (!entry.groups?.some(g => groupKey(g) === k)) entries[at] = { ...entry, groups: [...(entry.groups ?? []), name] };
  }
  return { entries, grouped, refused };
}

/** Removes the label from every entry; an entry that had it and has no other group goes away. */
export function dropGroup(current: WatchEntry[], group: string): { entries: WatchEntry[]; removed: string[] } {
  const k = groupKey(group);
  const removed: string[] = [];
  const entries: WatchEntry[] = [];
  for (const e of current) {
    if (!e.groups?.some(g => groupKey(g) === k)) { entries.push(e); continue; }
    const rest = e.groups.filter(g => groupKey(g) !== k);
    if (rest.length) entries.push({ ...e, groups: rest });
    else removed.push(e.symbol);
  }
  return { entries, removed };
}
