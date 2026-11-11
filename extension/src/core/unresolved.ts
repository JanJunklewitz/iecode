// Which saved watch entries no longer resolve on the target, reported once per symbol. Pure: no vscode.

import type { WatchItem } from './adswatch';

export interface UnresolvedEntry { symbol: string; error: string }

export class UnresolvedNotes {
  private readonly reported = new Set<string>();

  /**
   * Items with an error that were not reported yet. `exclude` (symbols of this call's add) are marked reported without
   * being returned: the add result already shows their error. A symbol that resolves or leaves the list is forgotten,
   * so it is reported again if it breaks again.
   */
  take(items: WatchItem[], exclude: string[] = []): UnresolvedEntry[] {
    const broken = new Map(items.filter(i => i.error).map(i => [i.symbol.toLowerCase(), i]));
    for (const k of [...this.reported]) if (!broken.has(k)) this.reported.delete(k);
    const skip = new Set(exclude.map(e => e.trim().toLowerCase()));
    const out: UnresolvedEntry[] = [];
    for (const [k, i] of broken) {
      if (this.reported.has(k)) continue;
      this.reported.add(k);
      if (!skip.has(k)) out.push({ symbol: i.symbol, error: i.error as string });
    }
    return out;
  }

  /** Forget everything (the target changed: the old answers say nothing about the new one). */
  reset(): void {
    this.reported.clear();
  }
}
