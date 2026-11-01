// An .xti file (first target: the PLC instance) flattened into an ordered list of identity key -> value entries.
// Keys are built from names, never from offsets or line numbers, so moved blocks and GUID churn do not show
// up as changes. Every entry has a category and may be flagged as noise (see docs/research/xti-diff).

import { parseXml, XNode, child } from '../xml';
import { unescapeText } from './iotree';

export type Category = 'tasks' | 'settings' | 'licenses' | 'unrestored' | 'parameters' | 'symbols' | 'types' | 'other' | 'layout' | 'metadata' | 'links';
export type Noise = 'guid' | 'build' | 'timestamps' | 'whitespace';

/** Display order; 'links' is only counted, never listed. */
export const CATEGORIES: Category[] = ['tasks', 'settings', 'licenses', 'unrestored', 'parameters', 'symbols', 'types', 'other', 'layout', 'metadata'];
export const NOISE: Noise[] = ['guid', 'build', 'timestamps', 'whitespace'];

/** value: normalised for comparison; raw: original text. */
export interface ConfigEntry { key: string; value: string; raw: string; category: Category; noise?: Noise }

const GUID_ATTRS = new Set(['GUID', 'GuidA', 'IdA']);
const LAYOUT = new Set(['BitSize', 'BitOffs', 'GetCodeOffs', 'SetCodeOffs', 'ReturnBitSize', 'ByteSize']);
// values that change on every build, found by the <Name> of their element
const BUILD_NAMES = new Set(['Application Timestamp', 'Refactory Counter', 'ChangeDate', 'GeneratedCodeSize', 'GlobalDataSize',
  'to_string_function', 'to_wstring_function']);
const METADATA_ATTRS = new Set(['TmcHash', 'LastKnownRefactorCnt']);

/** 100 ns ticks -> "10 ms". */
export function cycleTimeText(ticks: string): string {
  if (!/^\d+$/.test(ticks)) return ticks;
  return `${+(Number(ticks) / 10000).toFixed(3)} ms`;
}

const esc = (s: string) => s.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function flattenConfig(xml: string): ConfigEntry[] {
  const src = xml.replace(/^﻿/, '');
  const root = parseXml(src).children[0];
  const entries: ConfigEntry[] = [];
  if (!root) return entries;
  const seen = new Map<string, number>();

  // text of a leaf element, CDATA included
  const raw = (n: XNode) => src.slice(n.innerStart, n.innerEnd).split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map(s => (s.startsWith('<![CDATA[') ? s.slice(9, -3) : unescapeText(s))).join('');
  const txt = (n: XNode | undefined) => (n ? norm(raw(n)) : '');
  const add = (key: string, rawValue: string, category: Category, noise?: Noise) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    entries.push({ key: n > 1 ? `${key}#${n}` : key, value: norm(rawValue), raw: rawValue, category, noise });
  };
  const attrs = (n: XNode, key: string, category: Category, skip?: (a: string) => boolean) => {
    for (const [a, v] of Object.entries(n.attrs)) if (!skip?.(a)) add(`${key}/@${a}`, v, category, GUID_ATTRS.has(a) ? 'guid' : undefined);
  };
  const leaf = (n: XNode, key: string, category: Category, noise?: Noise, value = raw(n)) => {
    if (!Object.keys(n.attrs).length || norm(value) !== '') add(key, value, category, noise);
    attrs(n, key, category);
  };
  // compact one-line value of an element with children, e.g. "LBound=0 Elements=8"
  const compact = (n: XNode): string => [
    ...Object.entries(n.attrs).map(([k, v]) => `${k}=${v}`),
    ...(n.children.length ? n.children.map(c => `${c.name}=${compact(c)}`) : [txt(n)]),
  ].filter(s => s !== '').join(' ');
  const props = (n: XNode, key: string, category: Category) => {
    for (const p of n.children.filter(c => c.name === 'Property')) {
      const name = txt(child(p, 'Name'));
      const v = child(p, 'Value');
      add(`${key}/${esc(name)}`, v ? raw(v) : '', category, BUILD_NAMES.has(name) ? 'build' : undefined);
    }
  };

  // entity with a <Name>: all other children become keys below `key`; `special` may take over a child
  const fields = (n: XNode, key: string, category: Category, special?: (c: XNode) => boolean) => {
    attrs(n, key, category);
    for (const c of n.children) {
      if (special?.(c)) continue;
      if (c.name === 'Name') { attrs(c, key, category, a => a === 'Namespace'); continue; }
      if (c.name === 'Properties') { props(c, `${key}/Properties`, category); continue; }
      if (c.name === 'EnumInfo') { add(`${key}/EnumInfo/${esc(txt(child(c, 'Text')))}`, txt(child(c, 'Enum')), category); continue; }
      if (c.name === 'Default' || c.name === 'ArrayInfo') { add(`${key}/${c.name}`, compact(c), category); continue; }
      if (!c.children.length) { leaf(c, `${key}/${c.name}`, LAYOUT.has(c.name) ? 'layout' : category); continue; }
      const nm = child(c, 'Name');
      fields(c, `${key}/${c.name}${nm ? '/' + esc(txt(nm)) : ''}`, category);
    }
  };

  // generic fallback: path of element names, disambiguated by <Name> or sibling index
  const generic = (n: XNode, path: string, index: number) => {
    const nm = child(n, 'Name');
    const key = `${path}/${n.name}${nm ? `[${esc(txt(nm))}]` : `#${index}`}`;
    if (n.name === 'Mappings') return links(n, 'links', 'links', []);
    attrs(n, key, 'other');
    if (!n.children.length) { if (!Object.keys(n.attrs).length || txt(n) !== '') add(key, raw(n), 'other'); return; }
    const counts = new Map<string, number>();
    for (const c of n.children) {
      const i = counts.get(c.name) ?? 0;
      counts.set(c.name, i + 1);
      generic(c, key, i);
    }
  };

  // OwnerA / OwnerB nesting down to <Link VarA VarB>
  const links = (n: XNode, prefix: string, category: Category, owners: string[]) => {
    for (const c of n.children) {
      if (c.name === 'Link') {
        const key = [prefix, ...owners, esc(c.attrs.VarA ?? '')].join('/');
        if (category === 'links') add(key, c.attrs.VarB ?? '', category);
        else add(key, `${c.attrs.VarB ?? ''} (${c.attrs.RestoreInfo ?? ''})`, category);
        attrs(c, key, category, a => a === 'VarA' || a === 'VarB' || a === 'RestoreInfo');
      } else links(c, prefix, category, c.name.startsWith('Owner') ? [...owners, esc(c.attrs.Name ?? txt(child(c, 'Name')))] : owners);
    }
  };
  let importTimes = 0;
  const unrestored = (n: XNode) => {
    add(`unrestored/@ImportTime#${++importTimes}`, n.attrs.ImportTime ?? '', 'unrestored', 'timestamps');
    links(n, 'unrestored', 'unrestored', []);
  };

  const symbols = (area: XNode) => {
    const base = `symbols/${esc(txt(child(area, 'Name')))}`;
    fields(area, base, 'symbols', c => {
      if (c.name === 'AreaNo') { attrs(c, base, 'symbols'); return true; }
      if (c.name !== 'Symbol') return false;
      fields(c, `${base}/${esc(txt(child(c, 'Name')))}`, 'symbols');
      return true;
    });
  };

  // Instance, TmcDesc and anything else that holds the PLC description
  const item = (n: XNode) => {
    const counts = new Map<string, number>();
    for (const c of n.children) {
      const idx = counts.get(c.name) ?? 0;
      counts.set(c.name, idx + 1);
      const sub = (list: string, each: (e: XNode) => void) => c.children.filter(e => e.name === list).forEach(each);
      switch (c.name) {
        case 'Name': case 'CLSID': leaf(c, `instance/${c.name}`, 'settings'); break;
        case 'TmcDesc': item(c); break;
        case 'Contexts': sub('Context', e => fields(e, `tasks/${esc(txt(child(e, 'Name')))}`, 'tasks', x => {
          if (x.name !== 'CycleTime') return false;
          add(`tasks/${esc(txt(child(e, 'Name')))}/CycleTime`, cycleTimeText(txt(x)), 'tasks');
          return true;
        })); break;
        case 'TaskPouOids': sub('TaskPouOid', e => add(`tasks/pou-oids/${esc(e.attrs.OTCID ?? '')}/@Prio`, e.attrs.Prio ?? '', 'tasks')); break;
        case 'Licenses': sub('License', e => add(`licenses/${esc(txt(child(e, 'LicenseId')))}`, 'present', 'licenses')); break;
        case 'Parameters': sub('Parameter', e => fields(e, `parameters/${esc(txt(child(e, 'Name')))}`, 'parameters')); break;
        case 'ParameterValues': sub('Value', e => {
          const name = txt(child(e, 'Name'));
          const v = child(e, 'Value') ?? child(e, 'String') ?? child(e, 'Data');
          add(`parameter-values/${esc(name)}`, v ? raw(v) : '', 'parameters', BUILD_NAMES.has(name) ? 'build' : undefined);
        }); break;
        case 'Properties': props(c, 'properties', 'settings'); break;
        case 'DataAreas': sub('DataArea', symbols); break;
        case 'DataTypes': dataTypes(c); break;
        case 'UnrestoredVarLinks': unrestored(c); break;
        case 'Mappings': links(c, 'links', 'links', []); break;
        default: generic(c, 'other', idx);
      }
    }
  };

  const dataTypes = (n: XNode) => {
    for (const dt of n.children.filter(c => c.name === 'DataType')) {
      const nm = child(dt, 'Name');
      const ns = nm?.attrs.Namespace;
      fields(dt, `types/${ns ? esc(ns) + '.' : ''}${esc(txt(nm))}`, 'types');
    }
  };

  for (const [a, v] of Object.entries(root.attrs)) add(a === 'TcVersion' ? 'TcVersion' : `root/@${a}`, v, 'settings');
  const rootCounts = new Map<string, number>();
  for (const c of root.children) {
    const idx = rootCounts.get(c.name) ?? 0;
    rootCounts.set(c.name, idx + 1);
    visit(c, idx);
  }
  return entries;

  function visit(n: XNode, idx: number) {
    switch (n.name) {
      case 'Project':
        attrs(n, 'project', 'settings');
        n.children.forEach((c, i) => visit(c, i));
        break;
      case 'Instance':
        attrs(n, 'instance', 'settings', a => METADATA_ATTRS.has(a));
        for (const a of METADATA_ATTRS) if (n.attrs[a] !== undefined) add(`instance/@${a}`, n.attrs[a], 'metadata');
        item(n);
        break;
      case 'TmcDesc': item(n); break;
      case 'DataTypes': dataTypes(n); break;
      case 'Mappings': links(n, 'links', 'links', []); break;
      case 'UnrestoredVarLinks': unrestored(n); break;
      default: generic(n, 'other', idx);
    }
  }
}
