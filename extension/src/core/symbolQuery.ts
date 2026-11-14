// Which symbols an ads_symbols call asks for: filter, prefix, type and paging. Pure: no imports.
// Type matching is for queries only; the equivalence of the interface diff (adsinterface.ts) stays separate.

export interface SymbolQuery { filter: string; prefix: string; type: string; offset: number }
export const PAGE_SIZE = 100;

/** Upper case without blanks and namespaces; the build output stores a top-level BOOL as BIT. */
function queryType(t: string): string {
  return t.replace(/\s+/g, '').replace(/\b[A-Za-z_]\w*\.(?=[A-Za-z_])/g, '').toUpperCase().replace(/^BIT$/, 'BOOL');
}

/** `STRING` asks for every length; `STRING(20)` for that length only. */
function sameType(want: string, have: string): boolean {
  if (want === have) return true;
  return !/[([]/.test(want) && have.replace(/[([][^)\]]*[)\]]$/, '') === want;
}

/** The array elements a prefix names (`A[1].B[2].` gives `A[1]` and `A[1].B[2]`): their members are not in the symbol list unless asked for. */
export function elementPrefixes(prefix: string): string[] {
  const out: string[] = [];
  for (const m of prefix.matchAll(/\[[^\]]*\]/g)) {
    const end = m.index! + m[0].length;
    if (prefix[end] === '.') out.push(prefix.slice(0, end));
  }
  return out;
}

export function matchesQuery(s: { name: string; type: string }, q: SymbolQuery): boolean {
  const name = s.name.toLowerCase();
  if (q.filter && !name.includes(q.filter.toLowerCase())) return false;
  // symbol names write several indexes as [1,2]
  const prefix = q.prefix.toLowerCase().replace(/\s*,\s*/g, ',');
  if (prefix) {
    if (!name.startsWith(prefix)) return false;
    // a trailing dot lists direct members only, so an instance does not flood the answer with its subtree
    if (prefix.endsWith('.') && name.slice(prefix.length).includes('.')) return false;
    if (prefix.endsWith('.') && name.length === prefix.length) return false;
  }
  if (q.type) {
    const want = queryType(q.type);
    const have = queryType(s.type);
    const element = /^ARRAY\[.*\]OF(.+)$/.exec(have)?.[1];
    if (!sameType(want, have) && !(element !== undefined && sameType(want, element))) return false;
  }
  return true;
}

/** What the caller asked for, as words for the "nothing found" line. */
export function queryText(q: SymbolQuery): string {
  const parts: string[] = [];
  if (q.prefix) parts.push(`prefix ${q.prefix}`);
  if (q.type) parts.push(`type ${q.type}`);
  if (q.filter && !parts.length) return q.filter;
  if (q.filter) parts.unshift(`filter ${q.filter}`);
  return parts.join(' and ');
}

export function pageNote(o: { total: number; offset: number; pageSize: number }): string | undefined {
  const { total, offset, pageSize } = o;
  if (total > 0 && offset >= total) return `No rows at offset ${offset}: ${total} symbols match.`;
  const end = Math.min(total, offset + pageSize);
  if (offset === 0) return total > pageSize ? `(${total - pageSize} more not listed; narrow the filter or continue with offset ${pageSize})` : undefined;
  return end >= total
    ? `(rows ${offset + 1}-${end} of ${total}; end of list)`
    : `(rows ${offset + 1}-${end} of ${total}; ${total - end} more, continue with offset ${end})`;
}
