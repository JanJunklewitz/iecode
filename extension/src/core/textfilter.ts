// Filter text of a table. Self-contained: the ADS Interface page runs textFilter.toString() in its webview.

/**
 * Words separated by whitespace must all occur (each in any field), ignoring case. With regex the whole query
 * is one case-insensitive regular expression tested on each field; an invalid one hides nothing and sets error.
 */
export function textFilter(query: string, regex: boolean): { hit: (...fields: (string | undefined | null)[]) => boolean; error?: string } {
  if (regex && query) {
    try {
      const re = new RegExp(query, 'i');
      return { hit: (...fields) => fields.some(f => re.test(f ?? '')) };
    } catch (e) {
      return { hit: () => true, error: (e as Error).message };
    }
  }
  const words = regex ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
  return { hit: (...fields) => words.every(w => fields.some(f => (f ?? '').toLowerCase().includes(w))) };
}
