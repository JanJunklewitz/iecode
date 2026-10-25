// IO links ("Mappings") of a TwinCAT system project: which PLC / NC variable is linked to which
// IO channel. Stored in the .tsproj (and possibly in .xti files of independent IO devices) as
//
//   <Mappings>
//     <OwnerA Name="TIPC^PLC1^PLC1 Instance">
//       <OwnerB Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)">
//         <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input" />

import { parseXml, XNode } from '../xml';

export interface IoLink {
  /** Task / PLC / NC side, e.g. "TIPC^PLC1^PLC1 Instance^PlcTask Inputs^MAIN.bStart". */
  variable: string;
  /** IO side, e.g. "TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)^Channel 1^Input". */
  io: string;
  /** Other Link attributes (Size, OffsA, OffsB …), kept for comparison. */
  attrs: Record<string, string>;
  /** File the link is stored in (relative or absolute, as given). */
  file: string;
}

const isIo = (path: string) => /^TIID\^/i.test(path);

function* walk(n: XNode): Generator<XNode> { for (const c of n.children) { yield c; yield* walk(c); } }

/** Extracts all links from one .tsproj / .xti file. The IO side is always put into `io`. */
export function extractLinks(xml: string, file: string): IoLink[] {
  const root = parseXml(xml.replace(/^﻿/, ''));
  const out: IoLink[] = [];
  for (const a of walk(root)) {
    if (a.name !== 'OwnerA' || !a.attrs.Name) continue;
    for (const b of a.children) {
      if (b.name !== 'OwnerB' || !b.attrs.Name) continue;
      for (const l of b.children) {
        if (l.name !== 'Link') continue;
        const { VarA = '', VarB = '', ...attrs } = l.attrs;
        const sideA = `${a.attrs.Name}^${VarA}`;
        const sideB = `${b.attrs.Name}^${VarB}`;
        const [variable, io] = isIo(sideA) && !isIo(sideB) ? [sideB, sideA] : [sideA, sideB];
        out.push({ variable, io, attrs, file });
      }
    }
  }
  return out.sort((x, y) => x.variable.localeCompare(y.variable) || x.io.localeCompare(y.io));
}

export type LinkChangeKind = 'added' | 'removed' | 'moved' | 'changed';

export interface LinkChange {
  kind: LinkChangeKind;
  variable: string;
  /** IO channel before / after (moved: different channel for the same variable). */
  before?: string;
  after?: string;
  /** For 'changed': attributes that differ (same variable and channel). */
  details?: string;
}

const attrText = (a: Record<string, string>) => Object.entries(a).sort().map(([k, v]) => `${k}=${v}`).join(' ');

/**
 * Compares two sets of links by variable:
 * - moved: the variable is linked to other channels than before
 * - added / removed: variable linked only after / only before
 * - changed: same variable and channel, but Size / offsets differ
 * A variable can have several links (e.g. to several channels); they are compared as a set.
 */
export function diffLinks(before: IoLink[], after: IoLink[]): LinkChange[] {
  const group = (links: IoLink[]) => {
    const m = new Map<string, Map<string, IoLink>>();
    for (const l of links) {
      const v = m.get(l.variable) ?? new Map<string, IoLink>();
      v.set(l.io, l);
      m.set(l.variable, v);
    }
    return m;
  };
  const a = group(before), b = group(after);
  const out: LinkChange[] = [];
  for (const variable of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = a.get(variable), now = b.get(variable);
    if (!was) { for (const io of now!.keys()) out.push({ kind: 'added', variable, after: io }); continue; }
    if (!now) { for (const io of was.keys()) out.push({ kind: 'removed', variable, before: io }); continue; }
    const gone = [...was.keys()].filter(io => !now.has(io));
    const fresh = [...now.keys()].filter(io => !was.has(io));
    // pair up gone / fresh channels as moves, the rest are plain adds / removes
    const pairs = Math.min(gone.length, fresh.length);
    for (let i = 0; i < pairs; i++) out.push({ kind: 'moved', variable, before: gone[i], after: fresh[i] });
    for (const io of gone.slice(pairs)) out.push({ kind: 'removed', variable, before: io });
    for (const io of fresh.slice(pairs)) out.push({ kind: 'added', variable, after: io });
    for (const [io, l] of now) {
      const old = was.get(io);
      if (old && attrText(old.attrs) !== attrText(l.attrs))
        out.push({ kind: 'changed', variable, before: io, after: io, details: `${attrText(old.attrs) || '–'} → ${attrText(l.attrs) || '–'}` });
    }
  }
  return out;
}

/** Splits a TwinCAT tree path into a short, readable form: last 2 segments, e.g. "Term 2 (EL1008)^Channel 1^Input". */
export function shortPath(p: string, segments = 3): string {
  const parts = p.split('^');
  return parts.length <= segments ? p : '…^' + parts.slice(-segments).join('^');
}

/** CSV export (semicolon separated, like Excel in German locales expects). */
export function linksToCsv(links: IoLink[]): string {
  const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['Variable;IO;Attributes;File', ...links.map(l => [l.variable, l.io, attrText(l.attrs), l.file].map(q).join(';'))].join('\n') + '\n';
}

export function changesToCsv(changes: LinkChange[]): string {
  const q = (s = '') => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['Change;Variable;Before;After;Details', ...changes.map(c => [c.kind, c.variable, c.before, c.after, c.details].map(q).join(';'))].join('\n') + '\n';
}
