// Worker thread of searchText: streams the files with readLines and flags matching entries. No vscode imports.
import { parentPort } from 'worker_threads';
import { LogFormat, LogFormatDef, compileFormat, parseLine } from './logformat';
import { readLines } from './logscan';
import { TextQuery, compileQuery } from './logrows';

interface Input {
  paths: string[];
  file: Uint16Array;
  offset: Float64Array;
  length: Float64Array;
  formats: LogFormatDef[];
  q: TextQuery;
}

const MAX_TEXT_CHARS = 8192;
const MAX_TEXT_BYTES = MAX_TEXT_CHARS * 3;

/** Compiled formats of the last search; the live tail searches with the same ones every time. */
let compiled: { key: string; formats: LogFormat[] } | undefined;

function formatsOf(defs: LogFormatDef[]): LogFormat[] {
  const key = JSON.stringify(defs);
  if (compiled?.key !== key) compiled = { key, formats: defs.map(compileFormat) };
  return compiled.formats;
}

async function run(d: Input): Promise<{ flags: Uint8Array; bytesRead: number }> {
  const re = compileQuery(d.q);
  const formats = formatsOf(d.formats);
  const n = d.file.length;
  const flags = new Uint8Array(n);
  // Entries of one file in offset order; the entries of different files may be interleaved in the columns.
  // Counting sort into one typed array (a JS array per file cost ~8 bytes per entry plus its growth copies).
  const files = d.paths.length;
  const begin = new Uint32Array(files + 1);
  for (let i = 0; i < n; i++) begin[d.file[i] + 1]++;
  for (let f = 0; f < files; f++) begin[f + 1] += begin[f];
  const fill = begin.slice(0, files);
  const byFile = new Uint32Array(n);
  for (let i = 0; i < n; i++) byFile[fill[d.file[i]]++] = i;
  let bytesRead = 0;
  for (let f = 0; f < files; f++) {
    const list = byFile.subarray(begin[f], begin[f + 1]);
    if (list.length === 0) continue;
    // Scan order is offset order already; sort only if it is not.
    let sorted = true;
    for (let k = 1; k < list.length && sorted; k++) sorted = d.offset[list[k - 1]] <= d.offset[list[k]];
    if (!sorted) list.sort((a, b) => d.offset[a] - d.offset[b]);
    const format = formats[f];
    const start = d.offset[list[0]];
    let p = 0;                       // position in list of the entry the current line may belong to
    let end = start;
    for await (const batch of readLines(d.paths[f], { startOffset: start })) {
      for (const l of batch) {
        while (p < list.length && l.offset >= d.offset[list[p]] + d.length[list[p]]) p++;
        if (p >= list.length) break;
        const i = list[p];
        end = l.physEnd + l.terminator;
        if (l.offset < d.offset[i] || flags[i]) continue;
        // Only the bytes the entry had when it was indexed: an unterminated last line may have grown since.
        const entryEnd = l.start + (d.offset[i] + d.length[i] - l.offset);
        let text = l.buf.toString('utf8', l.start, Math.min(l.end, l.start + MAX_TEXT_BYTES, entryEnd));
        if (l.offset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
        let hit: boolean;
        if (l.offset === d.offset[i]) {
          const r = parseLine(format, text);
          hit = r.kind === 'entry'
            ? re.test(r.entry.source) || re.test(r.entry.message)
            : re.test(text);
        } else {
          hit = re.test(text);
        }
        if (hit) flags[i] = 1;
      }
      if (p >= list.length) break;
    }
    bytesRead += Math.max(0, end - start);
  }
  return { flags, bytesRead };
}

// One search per message; the worker stays for the next one until the host terminates it.
parentPort!.on('message', (d: Input) => {
  run(d).then(
    r => parentPort!.postMessage(r, [r.flags.buffer as ArrayBuffer]),
    e => parentPort!.postMessage({ error: (e as Error).message }),
  );
});
