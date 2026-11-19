// Checks of the IO links of a system project against the symbols of the built PLC (.tmc), which is what XAE resolves
// links against. Findings are anchored on the <Link> element of the file that stores the link.

import { Finding, Level, RuleInfo, offsetToPosition } from './findings';
import { normalizeLinkPath, parsePlcLinkSide, resolveLinkSymbol } from './ioLinkSymbols';
import { HwLink, shortName } from './iotree';
import type { TmcFile, TmcVar } from './tmc';

export interface LinkSource { link: HwLink; line: number }

export const IO_RULES: RuleInfo[] = [
  { id: 'io-dead-link', description: 'The PLC side of a link is not a symbol of the built PLC project', level: 'error' },
  { id: 'io-type-changed', description: 'The type stored in the link differs from the type of the PLC variable', level: 'warning' },
  { id: 'io-unlinked', description: 'A variable of an input or output area has no IO link (a hint: 94 of 725 symbols of a real project had none, and it is not verified that they are all gaps)', level: 'hint' },
  { id: 'io-channel-twice', description: 'Two PLC variables are linked to the same IO channel range', level: 'warning' },
  { id: 'io-not-built', description: 'The PLC project is not built (or older than its sources): link checks skipped', level: 'info' },
  { id: 'io-links-incomplete', description: 'A referenced file with links could not be read: unlinked variables are not reported', level: 'info' },
];

/** The line of each link's element, from `HwLink.at` and the text of the file that stores it (line 0 when unknown). */
export function withLines(links: HwLink[], textOf: (file: string) => string | undefined): LinkSource[] {
  return links.map(link => {
    const text = link.at === undefined ? undefined : textOf(link.file);
    return { link, line: text === undefined ? 0 : offsetToPosition(text, link.at!).line };
  });
}

export interface IoCheckOptions {
  /** Where findings without a link of their own go (an unlinked variable has no link); default: the first link of the PLC. */
  anchor?: { file: string; line: number };
  /** Set when a referenced file could not be read: the link set is incomplete, so unlinked variables are not reported. */
  incomplete?: string;
}

const normType = (t: string) => t.replace(/\s+/g, '').toUpperCase();
const areaKey = (name: string) => name.toLowerCase();

/** Symbols of each data area of the .tmc by area name, keyed by normalized path. */
function indexAreas(tmc: TmcFile): Map<string, { symbols: Map<string, TmcVar>; io: boolean }> {
  const out = new Map<string, { symbols: Map<string, TmcVar>; io: boolean }>();
  for (const m of tmc.modules) for (const a of m.areas) {
    const entry = out.get(areaKey(a.name)) ?? { symbols: new Map<string, TmcVar>(), io: /\s(Inputs|Outputs)$/i.test(a.name) };
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

export function checkIoLinks(links: LinkSource[], tmc: TmcFile | undefined, built: { stale: boolean }, plc: string, opts: IoCheckOptions = {}): Finding[] {
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
    at('io-not-built', level('io-not-built'), 'PLC project not built (or build is older than the sources): link checks skipped', anchor.file, anchor.line);
    return out;
  }

  const areas = indexAreas(tmc);
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
    at('io-links-incomplete', level('io-links-incomplete'), `Unlinked variables are not reported: ${opts.incomplete}`, anchor.file, anchor.line);
  } else {
    for (const [name, a] of areas) {
      if (!a.io) continue;
      for (const [key, s] of a.symbols)
        if (!linked.has(`${name}^${key}`)) at('io-unlinked', level('io-unlinked'), `${s.name} has no IO link`, anchor.file, anchor.line);
    }
  }

  // the same IO channel range linked to different PLC variables (of any PLC project of the system project)
  for (const { s, side } of mine) {
    const mineRange = range(s.link);
    const others = plcLinks.filter(o => o.s !== s && o.s.link.right === s.link.right && o.s.link.left !== s.link.left);
    const clash = others.filter(o => { const r = range(o.s.link); return !mineRange || !r || (mineRange.start < r.end && r.start < mineRange.end); });
    if (!clash.length) continue;
    const known = !!mineRange && clash.every(o => range(o.s.link));
    const output = /Outputs$/i.test(side.area);
    at('io-channel-twice', output && known ? 'warning' : 'info',
      `${shortName(s.link.right)} is also linked to ${clash.map(o => shortName(o.s.link.left)).join(', ')}${known ? '' : ' (bit ranges unknown)'}`, s.link.file, s.line);
  }
  return out;
}
