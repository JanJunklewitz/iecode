// Global text lists (.TcGTLO), image pools (.TcIPO) and the visualization manager (.TcVMO): CODESYS XmlArchives
// like visualizations. A model per kind for the editor, a YAML summary for diffs, and edits of single scalar values.
// As for visualizations, edits are splices of one <v> value: everything else stays byte-identical, and values
// stored as null (<n/>) or in structures we don't know are left to TwinCAT.

import { XNode, parseXml } from '../xml';
import { VisuEditError, encodeScalar, parseVisu, scalar, visuToText } from './tcvis';

/** One stored value: its path in the archive, display value, raw text and offset of the raw text (for edits). */
export interface Scalar {
  path: string;
  value: string;
  raw: string;
  at: number;
  kind: 'bool' | 'number' | 'string' | 'name' | 'guid';
}

export interface TextList {
  kind: 'textlist';
  name: string;
  languages: string[];
  rows: { id: string; text: string; translations: (Scalar | undefined)[] }[];   // translations by index of languages
}

export interface ImagePool {
  kind: 'imagepool';
  name: string;
  items: { id: string; itemId: number; file?: Scalar; path: string }[];   // path: relative to the PLC project folder
}

export interface VisuManager {
  kind: 'visumanager';
  name: string;
  settings: Scalar[];   // every stored value, e.g. ViewSettings.StartVisu33, VisuUserManagement.ApplyLoginRestrictions
}

export type PlcArchive = TextList | ImagePool | VisuManager;

const ROOTS: Record<string, PlcArchive['kind']> = { GlobalTextList: 'textlist', ImagePool: 'imagepool', VisuManager: 'visumanager' };

/** Files shown as a YAML summary in diffs instead of XML. */
export const SUMMARY_RE = /\.(TcVIS|TcGTLO|TcIPO|TcVMO)$/i;

const ch = (n: XNode | undefined, name: string) => n?.children.find(c => c.attrs.n === name);
const inner = (src: string, n: XNode) => src.slice(n.innerStart, n.innerEnd);
const vText = (src: string, n: XNode | undefined) => (n && n.name === 'v' ? scalar(inner(src, n)) : '');

function kindOf(raw: string): Scalar['kind'] {
  const t = raw.trim();
  if (t.startsWith('"')) return 'string';
  if (t === 'true' || t === 'false') return 'bool';
  if (/^-?\d+(U|L|UL)?$/.test(t)) return 'number';
  if (/^\{[0-9a-f-]{36}\}$/i.test(t)) return 'guid';
  return 'name';
}

const scalarOf = (src: string, v: XNode, path: string): Scalar =>
  ({ path, value: scalar(inner(src, v)), raw: inner(src, v), at: v.innerStart, kind: kindOf(inner(src, v)) });

/** All <v> values below a node, with dotted paths ("ViewSettings.ClientSizeX", "Keys[2]"). */
function scalars(src: string, node: XNode, prefix: string, out: Scalar[]) {
  let i = 0;
  for (const c of node.children) {
    const key = c.attrs.n;
    const p = key ? (prefix ? `${prefix}.${key}` : key) : `${prefix}[${i++}]`;
    if (c.name === 'v') out.push(scalarOf(src, c, p));
    else if (c.children.length) scalars(src, c, p, out);
  }
  return out;
}

/** The text list, image pool or visualization manager in a file (with or without BOM). */
export function parsePlcArchive(xml: string): PlcArchive {
  const src = xml.replace(/^﻿/, '');
  const top = parseXml(src).children.find(c => c.name === 'TcPlcObject');
  const el = top?.children.find(c => c.name in ROOTS);
  if (!el) throw new Error('not a TwinCAT text list, image pool or visualization manager');
  const data = el.children.find(c => c.name === 'XmlArchive')?.children.find(c => c.name === 'Data')?.children.find(c => c.name === 'o');
  if (!data) throw new Error(`${el.name} has no data`);
  const name = el.attrs.Name ?? '';
  const kind = ROOTS[el.name];

  if (kind === 'textlist') {
    const languages = (ch(data, 'Languages')?.children ?? []).filter(c => c.name === 'v').map(c => vText(src, c));
    const rows = (ch(data, 'TextList')?.children ?? []).filter(c => c.name === 'o').map(o => {
      const texts = (ch(o, 'LanguageTexts')?.children ?? []).filter(c => c.name === 'v' || c.name === 'n');
      const id = vText(src, ch(o, 'TextID'));
      return {
        id, text: vText(src, ch(o, 'TextDefault')),
        translations: languages.map((l, i) => (texts[i]?.name === 'v' ? scalarOf(src, texts[i], `${id}.${l}`) : undefined)),
      };
    });
    return { kind, name, languages, rows };
  }
  if (kind === 'imagepool') {
    const items = (ch(data, 'BitmapPool')?.children ?? []).filter(c => c.name === 'o').map(o => {
      const f = ch(o, 'FileID');
      const file = f?.name === 'v' ? scalarOf(src, f, 'FileID') : undefined;
      return { id: vText(src, ch(o, 'BitmapID')), itemId: Number(vText(src, ch(o, 'ItemID'))) || 0, file, path: (file?.value ?? '').replace(/^[^|]*\|/, '').replace(/\\/g, '/') };
    });
    return { kind, name, items };
  }
  return { kind, name, settings: scalars(src, data, '', []) };
}

// ---------- YAML summary (diffs) ----------

const q = (s: string) => (/^[A-Za-z_][\w.\-/ ]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function plcArchiveToText(a: PlcArchive): string {
  const out: string[] = [];
  if (a.kind === 'textlist') {
    out.push(`# Text list ${a.name} (${count(a.rows.length, 'text')})`, `name: ${q(a.name)}`);
    if (a.languages.length) out.push(`languages: [${a.languages.map(q).join(', ')}]`);
    out.push('texts:');
    for (const r of a.rows) {
      out.push(`  - ${JSON.stringify(r.id)}: ${q(r.text)}`);
      r.translations.forEach((t, i) => { if (t && t.value) out.push(`    ${q(a.languages[i])}: ${q(t.value)}`); });
    }
  } else if (a.kind === 'imagepool') {
    out.push(`# Image pool ${a.name} (${count(a.items.filter(i => i.id).length, 'image')})`, `name: ${q(a.name)}`, 'images:');
    for (const i of a.items) if (i.id || i.path) out.push(`  - ${q(i.id || `#${i.itemId}`)}: ${q(i.path)}`);
  } else {
    out.push(`# Visualization manager ${a.name}`, `name: ${q(a.name)}`, 'settings:');
    for (const s of a.settings) if (s.kind !== 'guid') out.push(`  ${s.path}: ${q(s.value)}`);
  }
  return out.join('\n') + '\n';
}

/** YAML summary of a visualization, text list, image pool or visualization manager (detected by content). */
export function summaryText(xml: string): string {
  const head = xml.slice(0, 600);
  return /<Visu\s/.test(head) ? visuToText(parseVisu(xml)) : plcArchiveToText(parsePlcArchive(xml));
}

// ---------- edits ----------

/** New value for the <v> whose raw text starts at `at` and currently is `old` (else the file changed meanwhile). */
export interface ArchiveEdit { at: number; old: string; value: string }

/** Text ranges to replace (on the text with BOM removed): [start, end, replacement], last first. */
export function archiveEditRanges(xml: string, edits: ArchiveEdit[]): [number, number, string][] {
  const byStart = new Map<number, XNode>();
  const stack = [parseXml(xml)];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'v') byStart.set(n.innerStart, n);
    stack.push(...n.children);
  }
  return edits.map(e => {
    const v = byStart.get(e.at);
    if (!v || inner(xml, v) !== e.old) throw new VisuEditError('the file changed meanwhile; try again');
    if (kindOf(e.old) === 'guid') throw new VisuEditError('ids are maintained by TwinCAT');
    return [v.innerStart, v.innerEnd, encodeScalar(e.old, e.value, false)] as [number, number, string];
  }).sort((a, b) => b[0] - a[0]);
}

/** The file text with the edits applied (BOM kept). */
export function applyArchiveEdits(xml: string, edits: ArchiveEdit[]): string {
  const bom = xml.startsWith('﻿') ? '﻿' : '';
  let src = bom ? xml.slice(1) : xml;
  for (const [s, e, r] of archiveEditRanges(src, edits)) src = src.slice(0, s) + r + src.slice(e);
  return bom + src;
}
