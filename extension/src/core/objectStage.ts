// Stage (or discard) one section of a PLC object file by splicing XML node ranges between two versions of the text.
// Nothing is decoded and re-encoded: encode() would give an added member a new random Id and drop its LineIds.

import { ViewError, sectionsOfXml } from '../model';
import { XNode, cdataText } from '../xml';

export interface Range { start: number; end: number }
export interface SectionRanges {
  key: string;
  /** Edit units: a method / action / transition: its element; MAIN: its Declaration and Implementation; an existing PROPERTY: its Declaration; GET / SET: the accessor element. */
  units: (Range & { name: 'node' | 'decl' | 'impl' })[];
  /** The whole element including nested accessors; used when a property is added or removed. */
  whole?: Range;
  lineIds: Range[];
  text: { decl?: string; impl?: string; raw?: string };
}

const nl = (s: string) => s.replace(/\r\n/g, '\n');
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? { bom: '﻿', body: s.slice(1) } : { bom: '', body: s });

/** Text of bytes that are valid UTF-8, with a BOM kept; undefined for bytes that would change when written back as text. */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : undefined;
}

/** True when the text has both CRLF and bare LF line endings. */
export function hasMixedEol(xml: string): boolean {
  return xml.includes('\r\n') && /(^|[^\r])\n/.test(xml);
}

interface Sec extends SectionRanges { kind: string; name: string; node: Range; order: number; childOf?: string }
interface Analysis { bom: string; body: string; eol: string; main: XNode; secs: Map<string, Sec> }

function analyze(xml: string): Analysis {
  const { bom, body } = stripBom(xml);
  const secs = sectionsOfXml(body);
  const main = secs[0].node;
  const mainName = main.attrs.Name;
  const lineStart = (pos: number) => body.lastIndexOf('\n', pos - 1) + 1;
  /** Whole lines of a node, including the line ending after it. */
  const lines = (n: { start: number; end: number }): Range => {
    const s = /^[ \t]*$/.test(body.slice(lineStart(n.start), n.start)) ? lineStart(n.start) : n.start;
    let e = n.end;
    const m = /^[ \t]*\r?\n/.exec(body.slice(e, e + 64));
    if (m) e += m[0].length;
    return { start: s, end: e };
  };
  const lineIdNodes = main.children.filter(c => c.name === 'LineIds');
  const idsFor = (...names: string[]) => lineIdNodes.filter(n => names.includes(n.attrs.Name)).map(lines);
  const out = new Map<string, Sec>();
  secs.forEach((s, order) => {
    const text: SectionRanges['text'] = {};
    if (s.decl) text.decl = nl(cdataText(s.decl) ?? '');
    if (s.st) text.impl = nl(cdataText(s.st) ?? '');
    else if (s.impl) text.raw = nl(body.slice(s.impl.innerStart, s.impl.innerEnd));
    const units: SectionRanges['units'] = [];
    let lineIds: Range[];
    if (s.kind === 'MAIN') {
      if (s.decl) units.push({ ...lines(s.decl), name: 'decl' });
      if (s.impl) units.push({ ...lines(s.impl), name: 'impl' });
      lineIds = idsFor(mainName);
    } else if (s.kind === 'PROPERTY') {
      if (s.decl) units.push({ ...lines(s.decl), name: 'decl' });
      lineIds = idsFor(`${mainName}.${s.name}`);
      // a property compares by its own declaration only; GET and SET are separate sections
      delete text.impl; delete text.raw;
    } else {
      units.push({ ...lines(s.node), name: 'node' });
      const acc = s.kind === 'GET' ? '.Get' : s.kind === 'SET' ? '.Set' : '';
      lineIds = idsFor(`${mainName}.${s.name}${acc}`);
    }
    out.set(s.key, { key: s.key, kind: s.kind, name: s.name, units, lineIds, text, node: lines(s.node), order,
      whole: s.kind === 'PROPERTY' ? lines(s.node) : undefined });
  });
  // property parts that take part in a whole-property operation
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { bom, body, eol, main, secs: out };
}

export function sectionRanges(xml: string): Map<string, SectionRanges> {
  const a = analyze(xml);
  return new Map([...a.secs].map(([k, s]) => [k, { key: s.key, units: s.units, whole: s.whole, lineIds: s.lineIds, text: s.text }]));
}

type State = 'added' | 'removed' | 'changed';

export function changedSections(baseXml: string, workXml: string): { key: string; state: State }[] {
  const base = analyze(baseXml), work = analyze(workXml);
  const out: { key: string; state: State }[] = [];
  const accessorOfAddedOrRemoved = (key: string, own: Analysis, other: Analysis) => {
    const [kind, name] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
    return (kind === 'GET' || kind === 'SET') && own.secs.has(`PROPERTY:${name}`) && !other.secs.has(`PROPERTY:${name}`);
  };
  for (const [key, w] of work.secs) {
    const b = base.secs.get(key);
    if (!b) { if (!accessorOfAddedOrRemoved(key, work, base)) out.push({ key, state: 'added' }); continue; }
    if (b.text.decl !== w.text.decl || b.text.impl !== w.text.impl || b.text.raw !== w.text.raw) out.push({ key, state: 'changed' });
  }
  for (const key of base.secs.keys())
    if (!work.secs.has(key) && !accessorOfAddedOrRemoved(key, base, work)) out.push({ key, state: 'removed' });
  return out;
}

interface Edit { start: number; end: number; text: string }

/** New text of `target` in which only section `key` is taken from `source`. */
function takeSection(targetXml: string, sourceXml: string, key: string): string {
  if (hasMixedEol(targetXml)) throw new ViewError('The file has mixed line endings (CRLF and LF); fix them first');
  const t = analyze(targetXml), s = analyze(sourceXml);
  const inT = t.secs.get(key), inS = s.secs.get(key);
  if (!inT && !inS) throw new ViewError(`Section ${key} does not exist`);
  const conv = (x: string) => x.replace(/\r\n/g, '\n').replace(/\n/g, t.eol);
  const slice = (a: Analysis, r: Range) => a.body.slice(r.start, r.end);
  // LineIds are named `<object>.<member>`: when the object was renamed, a copied entry takes the name of the target
  const srcName = s.main.attrs.Name, tgtName = t.main.attrs.Name;
  const idText = (r: Range) => {
    const x = conv(slice(s, r));
    return srcName === tgtName ? x : x.replace(/<LineIds Name="([^"]*)"/g, (m, n: string) =>
      n === srcName || n.startsWith(srcName + '.') ? `<LineIds Name="${tgtName}${n.slice(srcName.length)}"` : m);
  };
  const edits: Edit[] = [];
  const [kind, name] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];

  // a property that exists on one side only moves as a whole, with its accessors and all their LineIds
  const wholeProperty = kind === 'PROPERTY' && (!inT || !inS);
  const propNames = (a: Analysis) => [`PROPERTY:${name}`, `GET:${name}`, `SET:${name}`].filter(k => a.secs.has(k));
  const idsOf = (a: Analysis, sec?: Sec): Range[] => !sec ? [] : wholeProperty ? propNames(a).flatMap(k => a.secs.get(k)!.lineIds) : sec.lineIds;

  const lineIdInsertPos = (precedingKeyInT?: string): number => {
    if (precedingKeyInT) {
      const ids = idsOf(t, t.secs.get(precedingKeyInT));
      if (ids.length) return Math.max(...ids.map(r => r.end));
    }
    const all = t.main.children.filter(c => c.name === 'LineIds');
    if (all.length) {
      const last = all[all.length - 1];
      const e = last.end;
      const m = /^[ \t]*\r?\n/.exec(t.body.slice(e, e + 64));
      return m ? e + m[0].length : e;
    }
    return t.body.lastIndexOf('\n', t.main.innerEnd - 1) + 1;
  };

  if (inT && inS) {
    // changed: replace the units, then the LineIds entries
    for (const u of inT.units) {
      const su = inS.units.find(x => x.name === u.name);
      if (!su) throw new ViewError(`Section ${key} has no ${u.name} in the source`);
      edits.push({ start: u.start, end: u.end, text: conv(slice(s, su)) });
    }
    // a unit that only the source has cannot be spliced in: failing is better than reporting a no-op as staged
    for (const su of inS.units)
      if (!inT.units.some(x => x.name === su.name)) throw new ViewError(`Section ${key} gains a ${su.name} that the other version lacks: stage the whole file`);
    const tIds = inT.lineIds, sIds = inS.lineIds;
    const sText = sIds.map(idText).join('');
    if (tIds.length) {
      tIds.forEach((r, i) => edits.push({ start: r.start, end: r.end, text: i === 0 ? sText : '' }));
    } else if (sText) {
      edits.push({ start: lineIdInsertPos(), end: lineIdInsertPos(), text: sText });
    }
  } else if (inS) {
    // added: the element after the nearest preceding member (in the source order) that exists in the target
    let text: string, pos: number;
    let precedingKey: string | undefined;
    if (kind === 'GET' || kind === 'SET') {
      const prop = t.secs.get(`PROPERTY:${name}`);
      if (!prop) throw new ViewError(`${key} needs PROPERTY ${name} in the target`);
      text = conv(slice(s, inS.units[0]));
      // GET comes before SET, as TwinCAT writes them
      const set = kind === 'GET' ? t.secs.get(`SET:${name}`) : undefined;
      if (set) pos = set.node.start;
      else {
        pos = t.body.lastIndexOf('\n', t.body.indexOf('</Property>', prop.node.start) - 1) + 1;
        pos = Math.max(pos, prop.node.start);
      }
      precedingKey = kind === 'SET' && t.secs.has(`GET:${name}`) ? `GET:${name}` : `PROPERTY:${name}`;
    } else {
      const r = wholeProperty ? inS.whole! : inS.units[0];
      text = conv(slice(s, r));
      const preceding = [...s.secs.values()].filter(x => x.order < inS.order && x.kind !== 'GET' && x.kind !== 'SET' && x.kind !== 'MAIN' && t.secs.has(x.key))
        .sort((a, b) => b.order - a.order)[0];
      if (preceding) pos = t.secs.get(preceding.key)!.node.end;
      else {
        const first = t.main.children.find(c => c.name === 'LineIds');
        pos = first ? t.body.lastIndexOf('\n', first.start - 1) + 1 : t.body.lastIndexOf('\n', t.main.innerEnd - 1) + 1;
      }
      precedingKey = preceding?.key;
    }
    edits.push({ start: pos, end: pos, text });
    const sText = idsOf(s, inS).map(idText).join('');
    if (sText) { const p = lineIdInsertPos(precedingKey); edits.push({ start: p, end: p, text: sText }); }
  } else if (inT) {
    // removed: the element and all its LineIds entries
    const r = wholeProperty ? inT.whole! : inT.units[0];
    if (!r || inT.kind === 'MAIN') throw new ViewError('The main declaration cannot be removed');
    edits.push({ start: r.start, end: r.end, text: '' });
    for (const l of idsOf(t, inT)) edits.push({ start: l.start, end: l.end, text: '' });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = t.body;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // the splice works on line starts: a layout it does not expect (one-line elements) must not reach the index as broken XML
  let secs: Map<string, Sec>;
  try { secs = analyze(t.bom + out).secs; } catch { throw new ViewError(`Staging ${key} alone would produce an invalid file: stage the whole file`); }
  if (secs.has(key) !== !!inS) throw new ViewError(`Staging ${key} alone would put it in the wrong place: stage the whole file`);
  return t.bom + out;
}

/** New base text: only `key` is taken from the work text. */
export const stageSection = (baseXml: string, workXml: string, key: string) => takeSection(baseXml, workXml, key);
/** New work text: only `key` is taken from the base text. */
export const discardSection = (baseXml: string, workXml: string, key: string) => takeSection(workXml, baseXml, key);

export interface GuardInput { tracked: boolean; intentToAdd: boolean; conflict: boolean; decodes: boolean; dirty: boolean; mixedEol: boolean; utf8: boolean }

/** Why staging one section is refused, one message per reason; `wholeFile` marks the cases where staging the whole file is the way out. */
export function stageGuard(i: GuardInput): { ok: true } | { ok: false; message: string; wholeFile?: boolean } {
  if (i.dirty) return { ok: false, message: 'The file has unsaved changes: save first' };
  if (i.conflict) return { ok: false, message: 'The file has merge conflicts: resolve them first' };
  if (!i.tracked) return { ok: false, message: 'The file is not tracked by git yet: stage the whole file', wholeFile: true };
  if (i.intentToAdd) return { ok: false, message: 'The file is only marked as intent-to-add: stage the whole file', wholeFile: true };
  if (!i.utf8) return { ok: false, message: 'The file is not valid UTF-8: staging single sections would change other bytes' };
  if (i.mixedEol) return { ok: false, message: 'The file has mixed line endings (CRLF and LF): fix them first' };
  if (!i.decodes) return { ok: false, message: 'The file cannot be read as a PLC object' };
  return { ok: true };
}

/**
 * Why discarding one section is refused. Same checks as staging, but a file without a committed or staged version has nothing
 * to restore from, so there is no "whole file" way out. The command calls it again after the confirmation, with a fresh `dirty`.
 */
export function discardGuard(i: GuardInput): { ok: true } | { ok: false; message: string } {
  if (i.dirty) return { ok: false, message: 'The file has unsaved changes: save first (or close the editor without saving), then discard' };
  if (i.conflict) return { ok: false, message: 'The file has merge conflicts: resolve them first' };
  if (!i.tracked || i.intentToAdd) return { ok: false, message: 'The file has no committed or staged version to restore the section from' };
  if (!i.utf8) return { ok: false, message: 'The file is not valid UTF-8: discarding a single section would change other bytes' };
  if (i.mixedEol) return { ok: false, message: 'The file has mixed line endings (CRLF and LF): fix them first' };
  if (!i.decodes) return { ok: false, message: 'The file cannot be read as a PLC object' };
  return { ok: true };
}

const SECTION_WORDS: Record<string, string> = { METHOD: 'method', ACTION: 'action', PROPERTY: 'property', GET: 'property getter', SET: 'property setter' };

/** The modal question of the discard command: names the section and the file, and says there is no undo. */
export function discardConfirmText(key: string, fileName: string): string {
  const [kind, name] = key.split(':');
  const what = key === 'MAIN' ? 'the declaration' : `${SECTION_WORDS[kind] ?? kind.toLowerCase()} ${name}`;
  return `Discard your changes to ${what} in ${fileName}? This cannot be undone.`;
}

/** The file operations of `writeFileSafe`, injectable so a failing write can be tested without a read-only folder. */
export interface SafeWriteIo {
  write(path: string, content: Uint8Array | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Writes to a temporary file in the same folder, then renames it over the target: a failing write cannot leave a truncated file.
 * The temporary file is removed on every failure. (Remaining limit: an external writer between the caller's hash check and the rename.)
 */
export async function writeFileSafe(target: string, content: Uint8Array | string, io: SafeWriteIo): Promise<void> {
  const tmp = `${target}.iecode-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    await io.write(tmp, content);
    await io.rename(tmp, target);
  } catch (err) {
    await io.remove(tmp).catch(() => undefined);
    throw err;
  }
}
