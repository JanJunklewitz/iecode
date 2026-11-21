import * as fs from 'fs';

export interface SyntheticLogOptions {
  /** Number of undated entries written first (a logger prints them before the clock is set). */
  bootLines?: number;
  /** Seed of the deterministic generator. */
  seed?: number;
  /** Source names to draw from; default 2000. */
  sources?: number;
}

const LEVEL_NAMES = ['INFO', 'INFO', 'INFO', 'DEBUG', 'DEBUG', 'WARNING', 'ERROR'];
const MESSAGES = ['Cycle done', 'Value changed', 'State entered', 'Request sent', 'Timeout waiting for ack', 'Position reached'];
const BLOCK = 1024 * 1024;

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/**
 * Writes a generic logger file of at least `bytes` bytes (it ends on a line boundary):
 * a header, entries `<seq> - <time> - <LEVEL> - <source> - <message>`, and every 40th entry with two continuation lines.
 */
export function writeSyntheticLog(path: string, bytes: number, opts: SyntheticLogOptions = {}): void {
  let state = (opts.seed ?? 1) >>> 0;
  const rnd = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const sourceCount = opts.sources ?? 2000;
  const fd = fs.openSync(path, 'w');
  try {
    let written = 0;
    let seq = 0;
    let t = Date.UTC(2026, 0, 15, 8, 0, 0, 0);
    let boot = opts.bootLines ?? 0;
    let block = 'Sequence   - Timestamp - Category - Source - Message\n';
    while (written < bytes) {
      while (block.length < BLOCK && written + block.length < bytes) {
        seq++;
        let time: string;
        if (boot > 0) {
          boot--;
          time = '0000-00-00-00:00:00.000';
        } else {
          t += rnd(2000);
          const d = new Date(t);
          time = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}-${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`;
        }
        const source = `fbMain.fbUnit${rnd(sourceCount)}.fbValve`;
        block += `${pad(seq, 10)} - ${time} - ${LEVEL_NAMES[rnd(LEVEL_NAMES.length)]} - ${source} - ${MESSAGES[rnd(MESSAGES.length)]} ${rnd(100000)}\n`;
        if (seq % 40 === 0) block += `  detail ${rnd(1000)}\n  detail ${rnd(1000)}\n`;
      }
      const buf = Buffer.from(block, 'utf8');
      fs.writeSync(fd, buf);
      written += buf.length;
      block = '';
    }
  } finally {
    fs.closeSync(fd);
  }
}
