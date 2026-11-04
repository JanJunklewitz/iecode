// Timeline order and filters over an EntryStore. No vscode imports.

import { EntryStore } from './logstore';
import { Level, LEVELS } from './logformat';

export interface Filters {
  /** Visible levels; all five by default. */
  levels: Level[];
  /** Inclusive wall-clock bounds in ms; entries without a time always pass. */
  from?: number;
  to?: number;
  /** Case-insensitive substring of the source. */
  source?: string;
  /** Match flag per entry (indexed by entry), undefined = no text filter. */
  text?: Uint8Array;
}

export interface FilterResult {
  indices: Uint32Array;
  /** Entries that pass every other filter but fail this one. */
  hiddenBy: { level: number; time: number; source: number; text: number };
}

/**
 * One file: entries in scan order. Several files: k-way merge of the per-file runs by sortTime,
 * ties by file index. A run is only consumed from its head, so a file never gets reordered.
 */
export function timelineOrder(store: EntryStore, fileCount: number): Uint32Array {
  const n = store.count;
  const out = new Uint32Array(n);
  if (fileCount <= 1) {
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }

  // Group entry indices per file (counting sort keeps store order inside a file).
  const start = new Uint32Array(fileCount + 1);
  const file = store.file;
  for (let i = 0; i < n; i++) start[file[i] + 1]++;
  for (let f = 0; f < fileCount; f++) start[f + 1] += start[f];
  const fill = start.slice(0, fileCount);
  const grouped = new Uint32Array(n);
  for (let i = 0; i < n; i++) grouped[fill[file[i]]++] = i;

  const sortTime = store.sortTime;
  const pos = start.slice(0, fileCount);   // next unread position per file
  const heap = new Uint32Array(fileCount); // file ids ordered by their head entry
  let size = 0;

  const less = (a: number, b: number): boolean => {
    const ta = sortTime[grouped[pos[a]]];
    const tb = sortTime[grouped[pos[b]]];
    return ta < tb || (ta === tb && a < b);
  };
  const siftDown = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) return;
      const r = l + 1;
      const m = r < size && less(heap[r], heap[l]) ? r : l;
      if (!less(heap[m], heap[i])) return;
      const tmp = heap[i]; heap[i] = heap[m]; heap[m] = tmp;
      i = m;
    }
  };

  for (let f = 0; f < fileCount; f++) {
    if (pos[f] < start[f + 1]) heap[size++] = f;
  }
  for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(i);

  let o = 0;
  while (size > 0) {
    const f = heap[0];
    out[o++] = grouped[pos[f]++];
    if (pos[f] >= start[f + 1]) heap[0] = heap[--size];
    siftDown(0);
  }
  return out;
}

const FAIL_LEVEL = 1;
const FAIL_TIME = 2;
const FAIL_SOURCE = 4;
const FAIL_TEXT = 8;

export function applyFilters(store: EntryStore, order: Uint32Array, f: Filters): FilterResult {
  const levelOk = new Uint8Array(LEVELS.length);
  for (const l of f.levels) {
    const i = LEVELS.indexOf(l);
    if (i >= 0) levelOk[i] = 1;
  }

  let sourceOk: Uint8Array | undefined;
  if (f.source) {
    const needle = f.source.toLowerCase();
    sourceOk = new Uint8Array(store.sources.length);
    for (let i = 0; i < sourceOk.length; i++) {
      if (store.sources[i].toLowerCase().includes(needle)) sourceOk[i] = 1;
    }
  }

  const from = f.from ?? -Infinity;
  const to = f.to ?? Infinity;
  const timeFilter = f.from !== undefined || f.to !== undefined;
  const { level, time, source } = store;
  const text = f.text;

  const kept = new Uint32Array(order.length);
  let k = 0;
  let hLevel = 0, hTime = 0, hSource = 0, hText = 0;
  for (let j = 0; j < order.length; j++) {
    const i = order[j];
    let mask = 0;
    if (!levelOk[level[i]]) mask |= FAIL_LEVEL;
    if (timeFilter) {
      const t = time[i];
      if (t === t && (t < from || t > to)) mask |= FAIL_TIME;
    }
    if (sourceOk && !sourceOk[source[i]]) mask |= FAIL_SOURCE;
    if (text && !text[i]) mask |= FAIL_TEXT;
    switch (mask) {
      case 0: kept[k++] = i; break;
      case FAIL_LEVEL: hLevel++; break;
      case FAIL_TIME: hTime++; break;
      case FAIL_SOURCE: hSource++; break;
      case FAIL_TEXT: hText++; break;
    }
  }
  return { indices: kept.slice(0, k), hiddenBy: { level: hLevel, time: hTime, source: hSource, text: hText } };
}
