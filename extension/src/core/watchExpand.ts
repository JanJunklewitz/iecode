// `ads_watch { expand: true }`: the members of a structure are watched instead of the structure itself. Pure: the read rows
// come in, the names to add and the notes for the result come out.

import type { ReadMember, ReadNotes } from './adsToolText';

export const EXPAND_MAX_MEMBERS = 200;

export interface ExpandRow { symbol: string; error: string | null; members?: ReadMember[]; notes?: ReadNotes }

/**
 * A row with members is replaced by those members that were read without an error (a member that failed would only be an
 * item error in the list); every other symbol keeps its name, so the watch call reports its own error. Names are unique,
 * compared without case.
 */
export function expandAdds(add: string[], rows: ExpandRow[]): { names: string[]; lines: string[] } {
  const byName = new Map(rows.map(r => [r.symbol.trim().toLowerCase(), r]));
  const names: string[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  const push = (n: string) => {
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      names.push(n);
    }
  };
  for (const a of add) {
    const row = byName.get(a.trim().toLowerCase());
    if (!row?.members || row.error) {
      push(a);
      continue;
    }
    const good = row.members.filter(m => !m.error);
    for (const m of good) push(m.name);
    lines.push(`Expanded ${a.trim()} into ${good.length} watched member${good.length === 1 ? '' : 's'}.`);
    const failed = row.members.filter(m => m.error).map(m => m.name);
    if (failed.length) lines.push(`Not added (read error): ${failed.join(', ')}`);
    if (row.notes && row.notes.omittedMembers > 0) lines.push(`${a.trim()}: ${row.notes.omittedMembers} more members not added (the limit is ${EXPAND_MAX_MEMBERS}).`);
  }
  return { names, lines };
}
