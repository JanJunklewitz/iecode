// Checks of the IO links of a system project against the symbols of the built PLC (.tmc), which is what XAE resolves
// links against. Findings are anchored on the <Link> element of the file that stores the link.

import { Finding, Level, RuleInfo } from './findings';
import { normalizeLinkPath, parsePlcLinkSide, resolveLinkSymbol } from './ioLinkSymbols';
import { HwLink, shortName } from './iotree';
import type { TmcFile, TmcVar } from './tmc';

export interface LinkSource { link: HwLink; line: number }

export const IO_RULES: RuleInfo[] = [
  { id: 'io-dead-link', description: 'The PLC side of a link is not a symbol of the built PLC project', level: 'error' },
  { id: 'io-type-changed', description: 'The type stored in the link differs from the type of the PLC variable', level: 'warning' },
  { id: 'io-unlinked', description: 'Variables of an input or output area have no IO link (a hint: it is not verified that all of them are gaps); one finding per area', level: 'hint' },
  { id: 'io-channel-twice', description: 'Two PLC outputs are linked to the same IO channel range', level: 'warning' },
  { id: 'io-channel-twice-weak', description: 'Two PLC inputs, or outputs with unknown bit ranges, are linked to the same IO channel', level: 'info' },
  { id: 'io-not-built', description: 'The PLC project has no usable build (missing, older than its sources or unreadable): link checks skipped', level: 'info' },
  { id: 'io-links-incomplete', description: 'A referenced file with links could not be read: unlinked variables are not reported', level: 'info' },
];

/** The line of each link's element, from `HwLink.at` and the text of the file that stores it (line 0 when unknown). */
export function withLines(links: HwLink[], textOf: (file: string) => string | undefined): LinkSource[] {
  // the offsets of the line breaks of each file, scanned once: a file can hold hundreds of links
  const breaks = new Map<string, number[] | undefined>();
  const breaksOf = (file: string) => {
    if (!breaks.has(file)) {
      const text = textOf(file);
      const list: number[] | undefined = text === undefined ? undefined : [];
      if (text !== undefined) for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) list!.push(i);
      breaks.set(file, list);
    }
    return breaks.get(file);
  };
  return links.map(link => {
    const list = link.at === undefined ? undefined : breaksOf(link.file);
    if (!list) return { link, line: 0 };
    // the line is the number of line breaks before the offset (same result as offsetToPosition)
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < link.at!) lo = mid + 1; else hi = mid; }
    return { link, line: lo };
  });
}

/** The finding for a system project file that cannot be read: without it every link check would look like "all fine". */
export function unreadableProjectFinding(file: string, level: Level = 'info'): Finding {
  return { rule: 'io-links-incomplete', level, message: `${file}: the project file could not be read, IO links not checked`, file, space: 'xml', line: 0, col: 0, endLine: 0, endCol: 1 };
}

export interface IoCheckOptions {
  /** Where findings without a link of their own go (an unlinked variable has no link); default: the first link of the PLC. */
  anchor?: { file: string; line: number };
  /** Set when a referenced file could not be read: the link set is incomplete, so unlinked variables are not reported. */
  incomplete?: string;
}

const UNLINKED_SHOWN = 5;
const normType =(t: string) => t.replace(/\s+/g, '').toUpperCase();
const areaKey = (name: string) => name.toLowerCase();

/** Symbols of each data area of the .tmc by area name, keyed by normalized path. */
function indexAreas(tmc: TmcFile): Map<string, { name: string; symbols: Map<string, TmcVar>; io: boolean }> {
  const out = new Map<string, { name: string; symbols: Map<string, TmcVar>; io: boolean }>();
  for (const m of tmc.modules) for (const a of m.areas) {
    const entry = out.get(areaKey(a.name)) ?? { name: a.name, symbols: new Map<string, TmcVar>(), io: /\s(Inputs|Outputs)$/i.test(a.name) };
    for (const s of a.symbols) entry.symbols.set(normalizeLinkPath(s.name), s);
    out.set(areaKey(a.name), entry);
  }
  return out;
}

const range = (l: HwLink): { start: number; end: number } | undefined => {
  const start = l.offsRight === undefined ? NaN : Number(l.offsRight);
  if (!Number.isFinite(start)) return undefined;
  const size = l.size === undefined ? 1 : Number(l.size);
  return { start, end: start + (Number.isFinite(size) && size > 0 ? size : 1) };
};

export function checkIoLinks(links: LinkSource[], tmc: TmcFile | undefined, built: { stale: boolean; unreadable?: string }, plc: string, opts: IoCheckOptions = {}): Finding[] {
  const out: Finding[] = [];
  const at = (rule: string, level: Level, message: string, file: string, line: number) =>
    out.push({ rule, level, message, file, space: 'xml', line, col: 0, endLine: line, endCol: 1 });
  const level = (id: string) => IO_RULES.find(r => r.id === id)!.level as Level;

  // PLC area links only: a safety link or an IO / NC pair has no `<plc> Instance^<task> Inputs|Outputs` side
  const plcLinks = links.flatMap(s => { const side = parsePlcLinkSide(s.link.left); return side ? [{ s, side }] : []; });
  const mine = plcLinks.filter(x => x.side.plc.toLowerCase() === plc.toLowerCase());
  if (!mine.length) return out;
  const anchor = opts.anchor ?? { file: mine[0].s.link.file, line: mine[0].s.line };

  if (!tmc || built.stale) {
    at('io-not-built', level('io-not-built'), built.unreadable
      ? `${plc}: the build output could not be read (${built.unreadable}): link checks skipped`
      : `${plc}: not built (or the build is older than the sources): link checks skipped`, anchor.file, anchor.line);
    return out;
  }

  const areas = indexAreas(tmc);
  if (!areas.size) {   // a format this reader does not understand would turn every link into a dead link
    at('io-not-built', level('io-not-built'), `${plc}: the build output has no data areas (an unknown format?): link checks skipped`, anchor.file, anchor.line);
    return out;
  }
  const linked = new Set<string>();
  for (const { s, side } of mine) {
    const area = areas.get(areaKey(side.area));
    const { symbol, viaParent } = area ? resolveLinkSymbol(side.path, area.symbols) : { symbol: undefined, viaParent: false };
    if (!symbol) {
      at('io-dead-link', level('io-dead-link'),
        `${side.path} is not a variable of ${side.area} in the built project; the link to ${shortName(s.link.right)} has no PLC side`, s.link.file, s.line);
      continue;
    }
    linked.add(`${areaKey(side.area)}^${normalizeLinkPath(symbol.name)}`);
    if (viaParent) continue;
    const stored = s.link.attrs[s.link.sideA === s.link.left ? 'TypeA' : 'TypeB'];
    if (stored !== undefined && normType(stored) !== normType(symbol.type))
      at('io-type-changed', level('io-type-changed'), `${side.path} is ${symbol.type} in the build but the link stores ${stored}`, s.link.file, s.line);
  }

  // an unlinked variable has no link line: it goes to the anchor
  if (opts.incomplete) {
    at('io-links-incomplete', level('io-links-incomplete'), `${plc}: unlinked variables are not reported: ${opts.incomplete}`, anchor.file, anchor.line);
  } else {
    // one finding per area: every one of them would sit on the same anchor line
    for (const [areaId, a] of areas) {
      if (!a.io) continue;
      const free = [...a.symbols].filter(([key]) => !linked.has(`${areaId}^${key}`)).map(([, s]) => s.name);
      if (!free.length) continue;
      const shown = free.slice(0, UNLINKED_SHOWN).join(', ') + (free.length > UNLINKED_SHOWN ? `, … (${free.length - UNLINKED_SHOWN} more)` : '');
      at('io-unlinked', level('io-unlinked'), `${plc}: ${free.length} variable(s) of ${a.name} have no IO link: ${shown}`, anchor.file, anchor.line);
    }
  }

  // the same IO channel range linked to different PLC variables (of any PLC project of the system project)
  for (const { s, side } of mine) {
    const mineRange = range(s.link);
    const others = plcLinks.filter(o => o.s !== s && o.s.link.right === s.link.right && o.s.link.left !== s.link.left);
    const clash = others.filter(o => { const r = range(o.s.link); return !mineRange || !r || (mineRange.start < r.end && r.start < mineRange.end); });
    if (!clash.length) continue;
    // strong only for a confirmed overlap of two outputs: a peer with an unknown range or an input does not hide it
    const known = !!mineRange && clash.every(o => range(o.s.link));
    const strong = /Outputs$/i.test(side.area) && !!mineRange && clash.some(o => {
      const r = range(o.s.link);
      return !!r && /Outputs$/i.test(o.side.area) && mineRange.start < r.end && r.start < mineRange.end;
    });
    const rule = strong ? 'io-channel-twice' : 'io-channel-twice-weak';
    at(rule, level(rule),
      `${shortName(s.link.right)} is also linked to ${clash.map(o => shortName(o.s.link.left)).join(', ')}${known ? '' : ' (bit ranges unknown)'}`, s.link.file, s.line);
  }
  return out;
}

export interface IoFindingRow { label: string; description: string; file: string; line: number; level: Level }

const LEVEL_ORDER: Record<Level, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** One row per finding for the "Checks" group of the IO links view: errors first, then by file and line. */
export function ioFindingRows(findings: Finding[]): IoFindingRow[] {
  return [...findings]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.file.localeCompare(b.file) || a.line - b.line)
    .map(f => ({ label: f.message, description: `${f.level} · ${f.rule}`, file: f.file, line: f.line, level: f.level }));
}
