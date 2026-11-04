// Performance check of the log viewer core on 100 MB files. Runs only with IECODE_PERF=1; run this file alone:
//   npx tsc -p . && IECODE_PERF=1 node --test out/test/logPerf.test.js
// Each case runs in a fresh child process (this file, with IECODE_PERF_CASE set), so the memory growth of one case
// does not hide that of the next: rss does not shrink once the process has grown.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { LogLimitError } from '../src/core/logstore';
import { LogSession } from '../src/core/logsession';
import { writeSyntheticLog } from './logGen';

const MB = 1024 * 1024;
const SIZE = 100 * MB;
const OPTS = { groupRepeats: false, gapMs: 1000 };
const TEXT = { query: 'Timeout waiting', regex: false, caseSensitive: false };

type Numbers = Record<string, number>;

/** Runs fn and reports its wall time and the event loop's max delay (resolution 10 ms) during it. */
async function measured<T>(fn: () => Promise<T> | T): Promise<{ value: T; wallMs: number; maxDelayMs: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = performance.now();
  try {
    const value = await fn();
    const wallMs = performance.now() - t0;
    // One more turn, so a block at the very end still lands in the histogram.
    await new Promise(r => setTimeout(r, 20));
    return { value, wallMs, maxDelayMs: h.max / 1e6 };
  } finally {
    h.disable();
  }
}

/** Samples rss every 50 ms (the search Worker's memory counts too) and reports the peak growth over the start in MB. */
function rssSampler(): { stop: () => number } {
  const base = process.memoryUsage().rss;
  let peak = base;
  const sample = () => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  };
  const timer = setInterval(sample, 50);
  return {
    stop: () => {
      sample();
      clearInterval(timer);
      return (peak - base) / MB;
    },
  };
}

function appendLines(p: string, n: number, seq0: number): void {
  let s = '';
  for (let k = 0; k < n; k++) {
    s += `${String(seq0 + k).padStart(10, '0')} - 2026-02-01-10:00:00.000 - ERROR - fbMain.fbUnit1.fbValve - Timeout waiting for ack ${k}\n`;
  }
  fs.appendFileSync(p, s);
}

/** The cases, run in the child process inside dir; each returns its measured numbers (times in ms, memory in MB). */
const cases: Record<string, (dir: string) => Promise<Numbers>> = {
  async logger(dir) {
    // About one million lines, five levels, 2000 sources, every 40th entry with two continuation lines.
    const file = path.join(dir, 'big.log');
    writeSyntheticLog(file, SIZE);
    const s = LogSession.open([file], [], OPTS);
    try {
      const rss = rssSampler();
      const load = await measured(() => s.load());
      const entries = s.state().total;
      const level = await measured(() => s.setFilters({ levels: ['error'] }));
      const levelMatched = s.state().matched;
      await s.setFilters({ levels: ['error', 'warning', 'info', 'debug', 'other'] });
      const search = await measured(() => s.setFilters({ text: TEXT }));
      const peak = rss.stop();
      const st = s.state();

      // Live tail with the text filter set: ten appended lines are searched and committed.
      appendLines(file, 10, entries + 1);
      const tail = await measured(() => s.refresh());
      const tailEntries = s.state().total;
      const tailError = s.state().liveError !== undefined;

      // Every commit rebuilds order, filter and view in O(n): once more without and once with grouping.
      await s.setFilters({ text: undefined });
      appendLines(file, 10, entries + 11);
      const commit = await measured(() => s.refresh());
      const group = await measured(() => s.setOptions({ groupRepeats: true }));
      appendLines(file, 10, entries + 21);
      const grouped = await measured(() => s.refresh());
      const change = await measured(() => s.setFilters({ levels: ['error', 'warning'] }));
      return {
        entries, loadMs: load.wallMs, loadDelayMs: load.maxDelayMs,
        levelMs: level.wallMs, levelDelayMs: level.maxDelayMs, levelMatched,
        searchMs: search.wallMs, searchDelayMs: search.maxDelayMs, searchMatched: st.matched, searchError: st.error ? 1 : 0,
        peakMb: peak,
        tailMs: tail.wallMs, tailDelayMs: tail.maxDelayMs, tailCommitted: tail.value ? 1 : 0, tailEntries, tailError: tailError ? 1 : 0,
        commitMs: commit.wallMs, commitDelayMs: commit.maxDelayMs, commitCommitted: commit.value ? 1 : 0,
        groupMs: group.wallMs, groupDelayMs: group.maxDelayMs,
        groupedMs: grouped.wallMs, groupedDelayMs: grouped.maxDelayMs, groupedCommitted: grouped.value ? 1 : 0,
        finalEntries: s.state().total,
        changeMs: change.wallMs, changeDelayMs: change.maxDelayMs,
      };
    } finally {
      await s.dispose();
    }
  },

  async merge(dir) {
    const paths = [0, 1, 2].map(k => path.join(dir, `merge${k}.log`));
    paths.forEach((p, k) => writeSyntheticLog(p, Math.ceil(SIZE / 3), { seed: k + 1 }));
    const s = LogSession.open(paths, [], OPTS);
    try {
      const load = await measured(() => s.load());
      return { entries: s.state().total, loadMs: load.wallMs, loadDelayMs: load.maxDelayMs };
    } finally {
      await s.dispose();
    }
  },

  async plain(dir) {
    const file = path.join(dir, 'plain.log');
    const block = Buffer.from('x\n'.repeat(MB / 2), 'latin1');
    const fd = fs.openSync(file, 'w');
    try {
      for (let k = 0; k < SIZE / MB; k++) fs.writeSync(fd, block);
    } finally {
      fs.closeSync(fd);
    }
    const s = LogSession.open([file], [], OPTS);
    try {
      const rss = rssSampler();
      const run = await measured(() => s.load().then(() => undefined, (e: unknown) => e));
      return { limitError: run.value instanceof LogLimitError ? 1 : 0, ms: run.wallMs, delayMs: run.maxDelayMs, peakMb: rss.stop() };
    } finally {
      await s.dispose();
    }
  },

  async sources(dir) {
    const file = path.join(dir, 'sources.log');
    writeSyntheticLog(file, SIZE, { sources: 500_000 });
    const s = LogSession.open([file], [], OPTS);
    try {
      const rss = rssSampler();
      const load = await measured(() => s.load());
      return { entries: s.state().total, loadMs: load.wallMs, loadDelayMs: load.maxDelayMs, peakMb: rss.stop() };
    } finally {
      await s.dispose();
    }
  },
};

const childCase = process.env.IECODE_PERF_CASE;
if (childCase) {
  const reply = (m: object): void => {
    process.send!(m, () => process.disconnect());
  };
  cases[childCase](process.env.IECODE_PERF_DIR!).then(
    r => reply({ ok: r }),
    (e: unknown) => reply({ error: (e as Error).stack ?? String(e) }),
  );
} else {
  const skip = process.env.IECODE_PERF !== '1' && 'set IECODE_PERF=1 to run the performance check';
  let tmp: string | undefined;
  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Runs one case in a fresh child process; its files go to a folder of their own, deleted afterwards. */
  const run = (name: string): Promise<Numbers> => {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'iecode-logperf-'));
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    return new Promise<Numbers>((resolve, reject) => {
      let result: { ok?: Numbers; error?: string } | undefined;
      const child = fork(__filename, [], {
        env: { ...process.env, IECODE_PERF_CASE: name, IECODE_PERF_DIR: dir }, execArgv: [],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      child.on('message', m => { result = m as typeof result; });
      child.on('error', reject);
      child.on('exit', code => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (result?.ok) resolve(result.ok);
        else reject(new Error(result?.error ?? `perf case ${name} exited with code ${code}`));
      });
    });
  };
  const ms = (n: number): string => `${n.toFixed(0)} ms`;
  const mb = (n: number): string => `${n.toFixed(0)} MB`;

  test('100 MB logger file: load, filter, search, live tail and publish stay within the limits', { skip }, async () => {
    const r = await run('logger');
    console.log(`load: ${ms(r.loadMs)}, ${r.entries} entries, event loop max ${ms(r.loadDelayMs)}`);
    console.log(`level filter: ${ms(r.levelMs)}, ${r.levelMatched} matched, event loop max ${ms(r.levelDelayMs)}`);
    console.log(`text search: ${ms(r.searchMs)}, ${r.searchMatched} matched, event loop max ${ms(r.searchDelayMs)}`);
    console.log(`peak rss growth during load and search: ${mb(r.peakMb)}`);
    console.log(`live tail (text filter, 10 lines): ${ms(r.tailMs)}, event loop max ${ms(r.tailDelayMs)}`);
    console.log(`refresh commit (no grouping): ${ms(r.commitMs)}, event loop max ${ms(r.commitDelayMs)}`);
    console.log(`setOptions groupRepeats: ${ms(r.groupMs)}, event loop max ${ms(r.groupDelayMs)}`);
    console.log(`refresh commit (grouping): ${ms(r.groupedMs)}, event loop max ${ms(r.groupedDelayMs)}`);
    console.log(`level change (grouping): ${ms(r.changeMs)}, event loop max ${ms(r.changeDelayMs)}`);

    assert.ok(r.entries > 900_000, `${r.entries} entries`);
    assert.ok(r.loadMs < 30_000, `load took ${ms(r.loadMs)}`);
    assert.ok(r.loadDelayMs < 200, `event loop blocked ${ms(r.loadDelayMs)} during load`);
    assert.ok(r.levelMs < 2000, `level filter took ${ms(r.levelMs)}`);
    assert.ok(r.levelDelayMs < 200, `event loop blocked ${ms(r.levelDelayMs)} during the level filter`);
    assert.equal(r.searchError, 0);
    assert.ok(r.searchMatched > 0 && r.searchMatched < r.entries);
    assert.ok(r.searchMs < 15_000, `text search took ${ms(r.searchMs)}`);
    assert.ok(r.searchDelayMs < 200, `event loop blocked ${ms(r.searchDelayMs)} during the search`);
    assert.ok(r.peakMb < 300, `rss grew by ${mb(r.peakMb)}`);

    assert.equal(r.tailCommitted, 1);
    assert.equal(r.tailEntries, r.entries + 10);
    assert.equal(r.tailError, 0);
    assert.ok(r.tailMs < 200, `refresh took ${ms(r.tailMs)}`);
    assert.ok(r.tailDelayMs < 200, `event loop blocked ${ms(r.tailDelayMs)} during the refresh`);
    assert.equal(r.commitCommitted, 1);
    assert.ok(r.commitDelayMs < 200, `event loop blocked ${ms(r.commitDelayMs)} during the commit`);
    assert.ok(r.groupDelayMs < 200, `event loop blocked ${ms(r.groupDelayMs)} during setOptions`);
    assert.equal(r.groupedCommitted, 1);
    assert.equal(r.finalEntries, r.entries + 30);
    assert.ok(r.groupedDelayMs < 200, `event loop blocked ${ms(r.groupedDelayMs)} during the grouped commit`);
    assert.ok(r.changeDelayMs < 200, `event loop blocked ${ms(r.changeDelayMs)} during the level change`);
  });

  test('three files merged on one timeline (100 MB together) keep the event loop free', { skip }, async () => {
    const r = await run('merge');
    console.log(`3-file merge load: ${ms(r.loadMs)}, ${r.entries} entries, event loop max ${ms(r.loadDelayMs)}`);
    assert.ok(r.loadMs < 30_000, `merge load took ${ms(r.loadMs)}`);
    assert.ok(r.loadDelayMs < 200, `event loop blocked ${ms(r.loadDelayMs)} during the merge load`);
  });

  test('100 MB plain file of 2-byte lines stops with LogLimitError', { skip }, async () => {
    const r = await run('plain');
    console.log(`plain 2-byte lines: stopped after ${ms(r.ms)}, peak rss growth ${mb(r.peakMb)}, event loop max ${ms(r.delayMs)}`);
    assert.equal(r.limitError, 1, 'expected LogLimitError');
    assert.ok(r.ms < 10_000, `took ${ms(r.ms)}`);
    assert.ok(r.peakMb < 400, `rss grew by ${mb(r.peakMb)}`);
  });

  test('100 MB logger file with 500,000 distinct sources loads below the source limit', { skip }, async () => {
    const r = await run('sources');
    console.log(`500,000 sources: load ${ms(r.loadMs)}, ${r.entries} entries, peak rss growth ${mb(r.peakMb)}, event loop max ${ms(r.loadDelayMs)}`);
    assert.ok(r.entries > 900_000, `${r.entries} entries`);
  });
}
