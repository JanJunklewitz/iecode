// Mermaid text for the project graph and the object graph. Ids are generated (`n1`, `n2` …) so no name needs sanitising;
// the readable name is only the label.

import type { NodeId, ObjectGraph, UnusedFinding } from './objectGraph';

/** Deterministic and injective: `n1`, `n2` … by sorted order of the distinct names. */
export function mermaidIds(names: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  [...new Set(names)].sort().forEach((n, i) => ids.set(n, `n${i + 1}`));
  return ids;
}

/** For a label inside double quotes: the quote and the entity start `#` are written as Mermaid entities. */
export const escapeLabel = (s: string) => s.replace(/#/g, '#35;').replace(/"/g, '#quot;');

export const MAX_NODES = 300;

/**
 * `flowchart LR` of the object graph. Members are folded into their object unless `members`; library nodes are left out.
 * `only` keeps those nodes and, unless `neighbours` is false, their direct neighbours. Unused nodes get the class `unused`.
 */
export function objectGraphMermaid(g: ObjectGraph, opts: { unused?: UnusedFinding[]; only?: NodeId[]; neighbours?: boolean; members?: boolean } = {}): string {
  const fold = (id: NodeId) => (opts.members ? id : g.nodes.get(id)?.owner ?? id);
  const visible = (id: NodeId) => { const n = g.nodes.get(id); return !!n && !n.library; };
  const edges = new Map<string, [NodeId, NodeId]>();
  for (const list of g.out.values()) for (const e of list) {
    if (!visible(e.from) || !visible(e.to)) continue;
    const a = fold(e.from), b = fold(e.to);
    if (a !== b) edges.set(`${a}\n${b}`, [a, b]);
  }

  let keep = new Set<NodeId>([...g.nodes.keys()].filter(visible).map(fold));
  if (opts.only) {
    const roots = new Set(opts.only.filter(visible).map(fold));
    keep = new Set(roots);
    if (opts.neighbours !== false) for (const [a, b] of edges.values()) { if (roots.has(a)) keep.add(b); if (roots.has(b)) keep.add(a); }
  }

  const ids = mermaidIds([...keep]);
  const label = (id: NodeId) => {
    const n = g.nodes.get(id)!;
    const owner = n.owner ? g.nodes.get(n.owner) : undefined;
    return escapeLabel(owner ? `${owner.name}.${n.name}` : n.name);
  };
  const lines = ['flowchart LR'];
  for (const [id, mid] of ids) lines.push(`  ${mid}["${label(id)}"]`);
  for (const [a, b] of edges.values()) if (keep.has(a) && keep.has(b)) lines.push(`  ${ids.get(a)} --> ${ids.get(b)}`);
  const unused = [...new Set((opts.unused ?? []).filter(f => opts.members || !g.nodes.get(f.id)?.owner).map(f => fold(f.id)))].filter(id => keep.has(id));
  if (unused.length) {
    lines.push('  classDef unused stroke-dasharray: 4 3');
    lines.push(`  class ${unused.map(id => ids.get(id)).join(',')} unused`);
  }
  return lines.join('\n');
}

/** Number of nodes in text made by `objectGraphMermaid`. */
export const mermaidNodeCount = (text: string) => (text.match(/^ {2}n\d+\["/gm) ?? []).length;
