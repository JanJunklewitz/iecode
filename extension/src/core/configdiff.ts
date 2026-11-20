// Comparison of two flattened .xti files by identity key, with filters for categories and noise kinds.

import { CATEGORIES, Category, ConfigEntry, Noise, unescapeKey } from './configmodel';
import { naturalSort, yamlScalar } from './iotree';
import { pairRenames } from './renameMatch';

export type Filter = Category | Noise;

export const DEFAULT_HIDDEN: Filter[] = ['layout', 'metadata', 'guid', 'build', 'timestamps', 'whitespace'];

/** `renamed`: `key` is the new entity (e.g. `tasks/New`), `from` the old one; the fields that changed besides the name follow as `changed` entries under the new key. */
export interface ConfigChange { kind: 'added' | 'removed' | 'changed' | 'renamed'; key: string; from?: string; category: Category; noise?: Noise; before?: string; after?: string }

const order = (c: Category) => { const i = CATEGORIES.indexOf(c); return i < 0 ? CATEGORIES.length : i; };
// repeated keys carry a "#n" suffix (see flattenConfig); they are matched as a group
const baseKey = (key: string) => key.replace(/#\d+$/, '');

function groupByBase(es: ConfigEntry[]): Map<string, ConfigEntry[]> {
  const m = new Map<string, ConfigEntry[]>();
  for (const e of es) { const b = baseKey(e.key); const l = m.get(b); if (l) l.push(e); else m.set(b, [e]); }
  return m;
}

const ENTITY_CATEGORIES = new Set<Category>(['tasks', 'symbols', 'parameters', 'types']);

/**
 * The item a key belongs to and the field below it, for the categories that have named items: `tasks/<task>/<field>`,
 * `parameters/<name>/<field>`, `types/<type>/<field>`, and for symbols `symbols/<area>/<symbol>/<field>` (three segments,
 * the area is part of the entity's group, not of the name). Other categories and the entries that belong to no item give undefined.
 */
export function entityOf(key: string): { entity: string; field: string; group: string } | undefined {
  const parts = key.split('/');
  const category = parts[0] as Category;
  if (!ENTITY_CATEGORIES.has(category)) return undefined;
  const depth = category === 'symbols' ? 3 : 2;
  if (parts.length <= depth || parts[1] === 'pou-oids') return undefined;
  return { entity: parts.slice(0, depth).join('/'), field: parts.slice(depth).join('/'), group: parts.slice(0, depth - 1).join('/') };
}

/**
 * Items that exist only before and only after are paired by the similarity of their fields (noise and layout entries do not
 * count as evidence). The old entries of a pair are re-keyed to the new name, so the normal diff then shows only what else changed.
 */
function pairEntities(before: ConfigEntry[], after: ConfigEntry[]): { before: ConfigEntry[]; renamed: ConfigChange[] } {
  const collect = (es: ConfigEntry[]) => {
    const m = new Map<string, { entity: string; group: string; category: Category; lines: string[] }>();
    for (const e of es) {
      const o = entityOf(e.key);
      if (!o) continue;
      const item = m.get(o.entity) ?? { entity: o.entity, group: o.group, category: e.key.split('/')[0] as Category, lines: [] };
      m.set(o.entity, item);
      if (!e.noise && e.category === item.category) item.lines.push(`${o.field}=${e.value}`);
    }
    return m;
  };
  const old = collect(before), now = collect(after);
  const gone = [...old.values()].filter(x => !now.has(x.entity));
  const fresh = [...now.values()].filter(x => !old.has(x.entity));
  const renames = new Map<string, string>();
  const renamed: ConfigChange[] = [];
  for (const group of new Set(gone.map(x => x.group))) {
    const pairs = pairRenames(gone.filter(x => x.group === group), fresh.filter(x => x.group === group), x => x.lines.join('\n'), { minLines: 2 });
    for (const p of pairs) {
      renames.set(p.from.entity, p.to.entity);
      renamed.push({ kind: 'renamed', key: p.to.entity, from: p.from.entity, category: p.to.category });
    }
  }
  if (!renames.size) return { before, renamed };
  const rekeyed = before.map(e => {
    const o = entityOf(e.key);
    const to = o && renames.get(o.entity);
    return to ? { ...e, key: to + e.key.slice(o.entity.length) } : e;
  });
  return { before: rekeyed, renamed };
}

export function diffConfig(beforeEntries: ConfigEntry[], after: ConfigEntry[]): ConfigChange[] {
  const { before, renamed } = pairEntities(beforeEntries, after);
  const changes: ConfigChange[] = [...renamed];
  const b = groupByBase(before);
  const a = groupByBase(after);
  for (const base of new Set([...b.keys(), ...a.keys()])) {
    const bs = [...(b.get(base) ?? [])];
    const as = [...(a.get(base) ?? [])];
    // equal values first, so reordered duplicates do not show up
    for (let i = as.length - 1; i >= 0; i--) {
      const j = bs.findIndex(x => x.value === as[i].value);
      if (j < 0) continue;
      const [x] = bs.splice(j, 1);
      const [y] = as.splice(i, 1);
      if (x.raw !== y.raw && !y.noise && !x.noise) changes.push({ kind: 'changed', key: y.key, category: y.category, noise: 'whitespace', before: x.raw, after: y.raw });
    }
    const pairs = Math.min(bs.length, as.length);
    for (let i = 0; i < pairs; i++) {
      changes.push({ kind: 'changed', key: as[i].key, category: as[i].category, noise: as[i].noise ?? bs[i].noise, before: bs[i].value, after: as[i].value });
    }
    for (const x of bs.slice(pairs)) changes.push({ kind: 'removed', key: x.key, category: x.category, noise: x.noise, before: x.value });
    for (const y of as.slice(pairs)) changes.push({ kind: 'added', key: y.key, category: y.category, noise: y.noise, after: y.value });
  }
  return changes.sort((x, y) => order(x.category) - order(y.category) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/** 'links' are never listed, only counted. */
export function isHidden(c: { category: Category; noise?: Noise }, hidden: ReadonlySet<Filter>): boolean {
  return c.category === 'links' || hidden.has(c.category) || (c.noise !== undefined && hidden.has(c.noise));
}

/** shown: the first `limit` visible changes; total: all visible ones; hidden: those filtered out. */
export interface CategoryGroup { category: Category; shown: ConfigChange[]; total: number; hidden: number }

export function groupChanges(changes: ConfigChange[], hidden: ReadonlySet<Filter>, limit = 500) {
  const groups: CategoryGroup[] = [];
  const hiddenBy: Partial<Record<Filter, number>> = {};
  let links = 0;
  for (const category of CATEGORIES) {
    const own = changes.filter(c => c.category === category);
    const visible = own.filter(c => !isHidden(c, hidden));
    for (const c of own) {
      if (!isHidden(c, hidden)) continue;
      if (hidden.has(c.category)) hiddenBy[c.category] = (hiddenBy[c.category] ?? 0) + 1;
      if (c.noise && hidden.has(c.noise)) hiddenBy[c.noise] = (hiddenBy[c.noise] ?? 0) + 1;
    }
    if (own.length) groups.push({ category, shown: visible.slice(0, limit), total: visible.length, hidden: own.length - visible.length });
  }
  for (const c of changes) if (c.category === 'links') links++;
  return { groups, links, hiddenBy };
}

interface YNode { value?: string; kids: Map<string, YNode> }

/** Visible entries as nested YAML, categories first; sorted by key so a moved block is no difference. */
export function configToYaml(entries: ConfigEntry[], hidden: ReadonlySet<Filter>, header?: string): string {
  const top = new Map<Category, YNode>();
  for (const e of entries) {
    if (isHidden(e, hidden)) continue;
    let node: YNode = top.get(e.category) ?? { kids: new Map() };
    top.set(e.category, node);
    const parts = e.key.split('/');
    if (parts[0] === e.category && parts.length > 1) parts.shift();
    for (const p of parts) {
      const next: YNode = node.kids.get(p) ?? { kids: new Map() };
      node.kids.set(p, next);
      node = next;
    }
    node.value = e.value;
  }
  const out: string[] = header ? [header] : [];
  const write = (n: YNode, depth: number) => {
    const ind = '  '.repeat(depth);
    for (const k of naturalSort([...n.kids.keys()])) {
      const kid = n.kids.get(k)!;
      const name = yamlScalar(unescapeKey(k));
      if (!kid.kids.size) { out.push(`${ind}${name}: ${yamlScalar(kid.value ?? '')}`); continue; }
      out.push(`${ind}${name}:`);
      if (kid.value !== undefined) out.push(`${ind}  (value): ${yamlScalar(kid.value)}`);
      write(kid, depth + 1);
    }
  };
  for (const c of CATEGORIES) {
    const n = top.get(c);
    if (!n) continue;
    out.push(`${c}:`);
    write(n, 1);
  }
  return out.map(l => l + '\n').join('');
}
