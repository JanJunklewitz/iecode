// Comparison of two flattened .xti files by identity key, with filters for categories and noise kinds.

import { CATEGORIES, Category, ConfigEntry, Noise, unescapeKey } from './configmodel';
import { naturalSort, yamlScalar } from './iotree';

export type Filter = Category | Noise;

export const DEFAULT_HIDDEN: Filter[] = ['layout', 'metadata', 'guid', 'build', 'timestamps', 'whitespace'];

export interface ConfigChange { kind: 'added' | 'removed' | 'changed'; key: string; category: Category; noise?: Noise; before?: string; after?: string }

const order = (c: Category) => { const i = CATEGORIES.indexOf(c); return i < 0 ? CATEGORIES.length : i; };
// repeated keys carry a "#n" suffix (see flattenConfig); they are matched as a group
const baseKey = (key: string) => key.replace(/#\d+$/, '');

function groupByBase(es: ConfigEntry[]): Map<string, ConfigEntry[]> {
  const m = new Map<string, ConfigEntry[]>();
  for (const e of es) { const b = baseKey(e.key); const l = m.get(b); if (l) l.push(e); else m.set(b, [e]); }
  return m;
}

export function diffConfig(before: ConfigEntry[], after: ConfigEntry[]): ConfigChange[] {
  const changes: ConfigChange[] = [];
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
