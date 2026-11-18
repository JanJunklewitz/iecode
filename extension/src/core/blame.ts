// Blame per section (method, property, accessor, action) of a PLC object file.
// git blames the XML line that carries a CDATA tag, so the first and last line of a body need repair:
// an appended line changes the line that held `]]></ST>`, and git then blames the old last line on the appending commit.

import { SectionSpan, ViewMap } from './objectSpans';
import { lineHistory } from './git';

export interface LineBlame {
  commit: string;
  author: string;
  time: number;
  summary: string;
  uncommitted: boolean;
  /** Line number and path in `commit` itself (porcelain header and `filename` line), not in the working file. */
  origLine: number;
  origPath: string;
}

export interface SectionBlame {
  key: string;
  last: LineBlame;
  authors: string[];
  /** Indexed by view line - span.viewFirst; undefined for header and marker lines. */
  lines: (LineBlame | undefined)[];
}

export type RefineLine = (current: LineBlame) => Promise<LineBlame>;

const ZERO = /^0+$/;

/** Parses `git blame --porcelain`; the result is indexed by (final) XML line - 1. */
export function parseBlamePorcelain(out: string): LineBlame[] {
  const result: LineBlame[] = [];
  const byCommit = new Map<string, { author: string; time: number; summary: string }>();
  let head: { commit: string; orig: number; final: number } | undefined;
  let filename = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      if (head) {
        const info = byCommit.get(head.commit) ?? { author: '', time: 0, summary: '' };
        const uncommitted = ZERO.test(head.commit);
        result[head.final - 1] = {
          commit: head.commit, author: uncommitted ? 'Not committed yet' : info.author, time: info.time, summary: info.summary,
          uncommitted, origLine: head.orig, origPath: filename,
        };
      }
      head = undefined;
      continue;
    }
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (h) {
      head = { commit: h[1], orig: Number(h[2]), final: Number(h[3]) };
      if (!byCommit.has(h[1])) byCommit.set(h[1], { author: '', time: 0, summary: '' });
      continue;
    }
    if (!head) continue;
    const info = byCommit.get(head.commit)!;
    if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('author-time ')) info.time = Number(line.slice(12));
    else if (line.startsWith('summary ')) info.summary = line.slice(8);
    else if (line.startsWith('filename ')) filename = line.slice(9);
  }
  return result;
}

/** A line that may have been stolen by a tag change, and the direction (into the body) its neighbours may share the theft. */
interface Candidate { index: number; step: 1 | -1 }

/**
 * The lines of a body whose blame may be a tag change, not a code change: the boundary lines, the old first line
 * (last line of the head run, same commit as the first line) and the old last line (first line of the tail run).
 */
function candidates(m: ViewMap, blames: (LineBlame | undefined)[]): Candidate[] {
  const n = m.xmlLines.length;
  const at = (i: number) => blames[i]?.commit;
  const out: Candidate[] = [];
  if (m.boundaryFirst) out.push({ index: 0, step: 1 });
  if (m.boundaryLast) out.push({ index: n - 1, step: -1 });
  let h = 0;
  while (h + 1 < n && at(h + 1) === at(0)) h++;
  out.push({ index: h, step: 1 });             // a prepend moved the old first line off the tag line
  let t = n - 1;
  while (t - 1 >= 0 && at(t - 1) === at(n - 1)) t--;
  out.push({ index: t, step: -1 });            // an append moved the old last line off the tag line
  return out.filter(c => blames[c.index] && !blames[c.index]!.uncommitted);
}

/**
 * Blame of one section on the lines of the ST view. `xml` is the blame of the whole file (index = XML line - 1).
 * Call it per section, on demand: refining runs `git log -L` for at most four lines per body.
 */
export async function blameSections(spans: SectionSpan[], xml: LineBlame[], refine: RefineLine): Promise<SectionBlame[]> {
  const out: SectionBlame[] = [];
  for (const span of spans) {
    const lines: (LineBlame | undefined)[] = new Array(span.viewLast - span.viewFirst + 1).fill(undefined);
    for (const m of [span.decl, span.impl]) {
      if (!m) continue;
      const blames = m.xmlLines.map(l => xml[l - 1]);
      const done = new Set<number>();
      for (const c of candidates(m, blames)) {
        // a refined line that lands on commit X may sit next to the old last (first) line of an earlier append (prepend) by X
        for (let i = c.index; i >= 0 && i < blames.length && !done.has(i) && blames[i] && !blames[i]!.uncommitted; i += c.step) {
          const before = blames[i]!;
          const after = await refine(before);
          blames[i] = after;
          done.add(i);
          const next = blames[i + c.step];
          if (after.commit === before.commit || !next || next.commit !== after.commit) break;
        }
      }
      blames.forEach((b, i) => { lines[m.viewFirst - span.viewFirst + i] = b; });
    }
    const known = lines.filter((l): l is LineBlame => !!l);
    if (!known.length) continue;
    let last = known[0];
    for (const l of known) if (l.uncommitted || (!last.uncommitted && l.time > last.time)) last = l;
    const authors = [...new Set(known.slice().sort((a, b) => b.time - a.time).map(l => l.author))];
    out.push({ key: span.key, last, authors, lines });
  }
  return out;
}

/** Text of a line without its CDATA tag parts: what the code says, not how the XML wraps it. */
export function stripTags(line: string): string {
  const SPLIT = '\u0000';                       // `]]]]><![CDATA[>` is a `]]>` inside code, not a tag
  let s = line.split(']]]]><![CDATA[>').join(SPLIT);
  const open = s.indexOf('<![CDATA[');
  if (open >= 0) s = s.slice(open + 9);
  const close = s.indexOf(']]>');
  if (close >= 0) s = s.slice(0, close);
  return s.split(SPLIT).join(']]>').trim();
}

/**
 * Walks `git log -L` of a line from the blamed commit back and returns the first commit that changed the code
 * text, not just its tag text. Keeps the current blame when the history says nothing better.
 */
export function makeRefine(root: string): RefineLine {
  return async current => {
    const entries = await lineHistory(root, current.commit, current.origPath, current.origLine);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.added === undefined) continue;
      const after = stripTags(e.added);
      const before = e.removed !== undefined ? stripTags(e.removed) : entries[i + 1]?.added !== undefined ? stripTags(entries[i + 1].added!) : undefined;
      if (before !== after) {
        return { ...current, commit: e.commit, author: e.author, time: e.time, summary: e.summary, uncommitted: false };
      }
    }
    return current;
  };
}

/** "3 weeks ago" for a time in the past; `now` and `time` are Unix seconds. */
function relativeTime(time: number, now: number): string {
  const s = Math.max(0, now - time);
  const units: [number, string][] = [[365 * 86400, 'year'], [30 * 86400, 'month'], [7 * 86400, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Text of the CodeLens above a section, e.g. `Ada Lovelace, 3 weeks ago: Fix cooling alarm (a1b2c3d)`. */
export function lensText(b: SectionBlame, now: number): string {
  if (b.last.uncommitted) return 'Not committed yet';
  return `${b.last.author}, ${relativeTime(b.last.time, now)}: ${b.last.summary} (${b.last.commit.slice(0, 7)})`;
}
