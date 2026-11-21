// Rows of the filtered timeline: grouping of repeated entries and navigation. Pure, no I/O, no vscode imports.
import { EntryStore } from './logstore';

export interface ViewOptions { groupRepeats: boolean; gapMs: number }

/**
 * The view a live-tail commit extends: its first `keep` indices are unchanged in the new view (they may share one
 * buffer). The new view reuses the rows before that point and may write into the old view's buffers, so the old view
 * must not be read afterwards.
 */
export interface ViewBase { view: LogView; keep: number }

/** Smallest binary-search answer: the first k in [lo, hi) with a[k] > x (hi when there is none). */
function upperBound(a: Uint32Array, lo: number, hi: number, x: number): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Built from the filtered entry indices (view order). With groupRepeats, consecutive entries of the view with equal
 * source and hash form one row; the hash covers level, source, message and continuation lines.
 */
export class LogView {
  readonly rowCount: number;
  /** Start position (into indices) of each row plus an end marker (may be longer); undefined = one entry per row. */
  private readonly starts?: Uint32Array;
  /** indices rise (a single file's view): entries are found by binary search. */
  private readonly sorted: boolean;

  constructor(private readonly store: EntryStore, private readonly indices: Uint32Array, o: ViewOptions, base?: ViewBase) {
    const n = indices.length;
    const keep = base ? Math.min(base.keep, n) : 0;
    let sorted = base && keep > 0 ? base.view.sorted : true;
    for (let j = Math.max(1, keep); j < n && sorted; j++) sorted = indices[j - 1] < indices[j];
    this.sorted = sorted;
    if (!o.groupRepeats || n === 0) {
      this.rowCount = n;
      return;
    }
    const { source, hash } = store;
    // Whether position j starts a row depends on j - 1 and j only, so the row starts before `keep` are unchanged: the
    // rows up to the one holding keep - 1 stay (that one may grow), and the decisions go on from keep. A long last
    // group of repeats is not gone over again.
    const prev = base?.view.starts;
    const reuse = prev !== undefined && keep > 0;
    const kept = reuse ? base!.view.rowOfPosition(keep - 1) + 1 : 0;
    const from = reuse ? keep : 0;
    const need = kept + (n - from) + 1;
    let starts: Uint32Array;
    if (reuse && prev!.length >= need) {
      starts = prev!;
    } else {
      starts = new Uint32Array(base ? Math.max(need, (prev?.length ?? 0) * 2) : n + 1);
      if (reuse) starts.set(prev!.subarray(0, kept));
    }
    let rows = kept;
    for (let j = from; j < n; j++) {
      const i = indices[j];
      if (j > 0) {
        const p = indices[j - 1];
        if (source[i] === source[p] && hash[i] === hash[p]) continue;
      }
      starts[rows++] = j;
    }
    starts[rows] = n;
    this.rowCount = rows;
    // A first build is trimmed; an extended one keeps its spare room for the next commit.
    this.starts = base ? starts : starts.slice(0, rows + 1);
  }

  private start(pos: number): number {
    return this.starts ? this.starts[pos] : pos;
  }

  /** Row holding view position j (0 <= j < indices.length). */
  private rowOfPosition(j: number): number {
    if (!this.starts) return j;
    return upperBound(this.starts, 0, this.rowCount, j) - 1;
  }

  /** Row holding entry `index`; -1 when the view does not show it. */
  rowOf(index: number): number {
    let j: number;
    if (this.sorted) {
      j = upperBound(this.indices, 0, this.indices.length, index) - 1;
      if (j < 0 || this.indices[j] !== index) return -1;
    } else {
      j = this.indices.indexOf(index);
      if (j < 0) return -1;
    }
    return this.rowOfPosition(j);
  }

  /** Rising, distinct rows holding any of the entries. */
  rowsOf(entries: Set<number>): number[] {
    const rows: number[] = [];
    if (this.sorted) {
      for (const i of entries) {
        const p = this.rowOf(i);
        if (p >= 0) rows.push(p);
      }
      rows.sort((a, b) => a - b);
    } else {
      // One pass over the view instead of one search per entry.
      for (let j = 0; j < this.indices.length; j++) {
        if (entries.has(this.indices[j])) rows.push(this.rowOfPosition(j));
      }
    }
    return rows.filter((p, k) => k === 0 || rows[k - 1] !== p);
  }

  /** index = first member of the row's group, repeat = group size; the window is clamped to the rows. */
  rowEntries(pos: number, count: number): { index: number; repeat: number }[] {
    const a = Math.max(0, pos);
    const b = Math.min(this.rowCount, pos + count);
    const out: { index: number; repeat: number }[] = [];
    for (let p = a; p < b; p++) {
      const s = this.start(p);
      out.push({ index: this.indices[s], repeat: this.start(p + 1) - s });
    }
    return out;
  }

  /** All entries of a row's group, in view order (a copy). */
  members(pos: number): Uint32Array {
    if (pos < 0 || pos >= this.rowCount) return new Uint32Array(0);
    return this.indices.slice(this.start(pos), this.start(pos + 1));
  }

  /** Whether any entry of the row's group passes `pred` (no copy). */
  someMember(pos: number, pred: (index: number) => boolean): boolean {
    if (pos < 0 || pos >= this.rowCount) return false;
    for (let j = this.start(pos), e = this.start(pos + 1); j < e; j++) if (pred(this.indices[j])) return true;
    return false;
  }

  /**
   * Time of the row before pos, taken from its last member (a long group must not make the next row look like a gap);
   * undefined for the first row or an entry without a time.
   */
  previousTime(pos: number): number | undefined {
    if (pos <= 0 || pos > this.rowCount) return undefined;
    const t = this.store.time[this.indices[this.start(pos) - 1]];
    return Number.isNaN(t) ? undefined : t;
  }

  /** First row after `from` (dir 1) or before it (dir -1) whose first member (and position) match; -1 when there is none. */
  find(from: number, dir: 1 | -1, pred: (index: number, pos: number) => boolean): number {
    let p = Math.max(-1, Math.min(this.rowCount, from)) + dir;
    for (; p >= 0 && p < this.rowCount; p += dir) {
      if (pred(this.indices[this.start(p)], p)) return p;
    }
    return -1;
  }
}
