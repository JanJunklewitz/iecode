// Pairs removed and added items by text similarity, to tell "renamed" from "deleted plus added".

const linesOf = (s: string) => s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/** Common non-blank trimmed lines (as multisets) divided by the larger line count; 0 when either side has no such line. */
export function similarity(a: string, b: string): number {
  const la = linesOf(a), lb = linesOf(b);
  if (!la.length || !lb.length) return 0;
  const count = new Map<string, number>();
  for (const l of la) count.set(l, (count.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of lb) {
    const n = count.get(l) ?? 0;
    if (n > 0) { common++; count.set(l, n - 1); }
  }
  return common / Math.max(la.length, lb.length);
}

/**
 * A pair needs a unique best partner on both sides (a tie gives no pair), a score of at least `threshold`
 * (default 0.7) and at least `minLines` (default 3) non-blank lines on both sides: identical one-liners are not evidence.
 */
export function pairRenames<T>(removed: T[], added: T[], text: (t: T) => string,
  opts: { threshold?: number; minLines?: number } = {}): { from: T; to: T; score: number }[] {
  const threshold = opts.threshold ?? 0.7, minLines = opts.minLines ?? 3;
  const big = (t: T) => linesOf(text(t)).length >= minLines;
  const scores = removed.map(r => added.map(a => (big(r) && big(a) ? similarity(text(r), text(a)) : 0)));
  /** Index of the single best entry of `row` at or above the threshold, or -1 for none or a tie. */
  const unique = (row: number[]) => {
    let best = -1, tie = false;
    row.forEach((s, i) => {
      if (s < threshold) return;
      if (best < 0 || s > row[best]) { best = i; tie = false; } else if (s === row[best]) tie = true;
    });
    return tie ? -1 : best;
  };
  const out: { from: T; to: T; score: number }[] = [];
  removed.forEach((r, i) => {
    const j = unique(scores[i]);
    if (j < 0 || unique(scores.map(row => row[j])) !== i) return;
    out.push({ from: r, to: added[j], score: scores[i][j] });
  });
  return out.sort((x, y) => y.score - x.score);
}
