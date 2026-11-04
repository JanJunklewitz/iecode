// Rows of the filtered timeline: grouping of repeated entries and navigation. Pure, no I/O, no vscode imports.
import { EntryStore } from './logstore';

export interface ViewOptions { groupRepeats: boolean; gapMs: number }

/**
 * Built from the filtered entry indices (view order). With groupRepeats, consecutive entries of the view with equal
 * source and hash form one row; the hash covers level, source, message and continuation lines.
 */
export class LogView {
  readonly rowCount: number;
  /** Start position (into indices) of each row plus an end marker; undefined = one entry per row. */
  private readonly starts?: Uint32Array;

  constructor(private readonly store: EntryStore, private readonly indices: Uint32Array, o: ViewOptions) {
    const n = indices.length;
    if (!o.groupRepeats || n === 0) {
      this.rowCount = n;
      return;
    }
    const { source, hash } = store;
    const starts = new Uint32Array(n + 1);
    let rows = 0;
    for (let j = 0; j < n; j++) {
      const i = indices[j];
      if (j > 0) {
        const p = indices[j - 1];
        if (source[i] === source[p] && hash[i] === hash[p]) continue;
      }
      starts[rows++] = j;
    }
    starts[rows] = n;
    this.rowCount = rows;
    this.starts = starts.slice(0, rows + 1);
  }

  private start(pos: number): number {
    return this.starts ? this.starts[pos] : pos;
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
