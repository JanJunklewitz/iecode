// Maps every line of the ST view (`decode(xml)`) back to the XML line it comes from, per section.
// Pure: XML text in, spans out. Mirrors the layout of `decode()` in model.ts line by line.

import { Kind, sectionsOfXml } from '../model';
import { XNode } from '../xml';

export interface ViewMap {
  viewFirst: number;      // 0-based, inclusive
  viewLast: number;       // 0-based, inclusive
  /** xmlLines[i] = XML line (1-based) of view line viewFirst + i */
  xmlLines: number[];
  /** The first body line shares its XML line with `<![CDATA[` of the first segment. */
  boundaryFirst: boolean;
  /** The last body line shares its XML line with `]]>` of the last segment. */
  boundaryLast: boolean;
}

export interface SectionSpan {
  key: string;
  kind: Kind;
  name: string;
  viewFirst: number;      // inclusive; the header line for every kind but MAIN
  viewLast: number;       // inclusive
  header?: number;        // view line of `//==== KIND Name ====` (not for MAIN)
  decl?: ViewMap;
  impl?: ViewMap;         // only for an ST implementation
}

/** XML line (1-based) of an offset, given the offsets of all '\n' in ascending order. */
function lineOf(newlines: number[], offset: number): number {
  let lo = 0, hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlines[mid] < offset) lo = mid + 1; else hi = mid;
  }
  return lo + 1;
}

/** The view lines of one body (declaration or ST) and the XML line of each. `first` is the view line the body starts at. */
function mapBody(node: XNode, first: number, newlines: number[]): ViewMap {
  const segs = node.cdata ?? [];
  // XML offset of each character of the joined, LF-normalised text; lineStart marks where a view line begins
  const lineStarts: number[] = [];   // XML offset a view line is anchored at
  let atLineStart = true;
  let lastOffset = segs.length ? segs[0].start + 9 : node.innerStart;
  for (const seg of segs) {
    const base = seg.start + 9;
    lastOffset = base;
    for (let i = 0; i < seg.text.length; i++) {
      const c = seg.text[i];
      if (c === '\r' && seg.text[i + 1] === '\n') continue;
      if (c === '\n') {
        if (atLineStart) lineStarts.push(base + i);    // empty line: anchored at its own newline
        atLineStart = true;
      } else if (atLineStart) {
        lineStarts.push(base + i);
        atLineStart = false;
      }
    }
    lastOffset = seg.end - 3;
  }
  if (atLineStart) lineStarts.push(lastOffset);        // the (possibly empty) last line
  const xmlLines = lineStarts.map(o => lineOf(newlines, o));
  const openLine = lineOf(newlines, segs.length ? segs[0].start : node.innerStart);
  const closeLine = lineOf(newlines, segs.length ? segs[segs.length - 1].end - 3 : node.innerStart);
  return {
    viewFirst: first,
    viewLast: first + xmlLines.length - 1,
    xmlLines,
    boundaryFirst: xmlLines[0] === openLine,
    boundaryLast: xmlLines[xmlLines.length - 1] === closeLine,
  };
}

export function spansOf(xml: string): SectionSpan[] {
  const newlines: number[] = [];
  for (let i = xml.indexOf('\n'); i >= 0; i = xml.indexOf('\n', i + 1)) newlines.push(i);

  const out: SectionSpan[] = [];
  let line = 0;
  for (const s of sectionsOfXml(xml)) {
    const span: SectionSpan = { key: s.key, kind: s.kind, name: s.name, viewFirst: line, viewLast: line };
    if (s.kind !== 'MAIN') span.header = line++;
    if (s.decl) {
      span.decl = mapBody(s.decl, line, newlines);
      line = span.decl.viewLast + 1;
    }
    if (s.impl) {
      line++;                                            // the `//---- IMPLEMENTATION ----` marker (or its read-only variant)
      if (s.st) {
        span.impl = mapBody(s.st, line, newlines);
        line = span.impl.viewLast + 1;
      }
    }
    // decode() pushes an empty string for a section without any line: it still takes one view line
    if (line === span.viewFirst) line++;
    span.viewLast = line - 1;
    out.push(span);
  }
  return out;
}

export function xmlLineOfViewLine(spans: SectionSpan[], viewLine: number): { span: SectionSpan; xmlLine?: number; boundary: boolean } | undefined {
  const span = spans.find(s => viewLine >= s.viewFirst && viewLine <= s.viewLast);
  if (!span) return undefined;
  for (const m of [span.decl, span.impl]) {
    if (m && viewLine >= m.viewFirst && viewLine <= m.viewLast) {
      return {
        span,
        xmlLine: m.xmlLines[viewLine - m.viewFirst],
        boundary: (viewLine === m.viewFirst && m.boundaryFirst) || (viewLine === m.viewLast && m.boundaryLast),
      };
    }
  }
  return { span, xmlLine: undefined, boundary: false };
}
