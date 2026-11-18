// Display data for unused objects: the tree, the editor hints and the list command show the same set.

import type { NodeId } from './objectGraph';
import type { UnitAnalysis } from './analysisState';

export interface UnusedMark {
  id: NodeId; name: string; file: string; line: number; col: number;
  confidence: 'unreferenced' | 'only-from-unused';
  text: string;
}

const TEXT = {
  unreferenced: 'Not referenced by any task or object',
  'only-from-unused': 'Only used by unused objects',
};

/** One mark per finding; a member of an unused object is folded into the object (which carries the mark). */
export function unusedMarks(a: UnitAnalysis): UnusedMark[] {
  const unusedIds = new Set(a.unused.map(f => f.id));
  const out: UnusedMark[] = [];
  for (const f of a.unused) {
    const n = a.graph.nodes.get(f.id);
    if (!n || n.library) continue;
    if (n.owner && unusedIds.has(n.owner)) continue;
    out.push({ id: n.id, name: n.name, file: n.file, line: n.line, col: n.col, confidence: f.confidence, text: TEXT[f.confidence] });
  }
  return out;
}

export function marksByFile(marks: UnusedMark[]): Map<string, UnusedMark[]> {
  const m = new Map<string, UnusedMark[]>();
  for (const k of marks) m.set(k.file, [...(m.get(k.file) ?? []), k]);
  return m;
}

/** Why there is nothing to show although the analysis ran: a skipped project must not look like "nothing is unused". */
export function emptyReason(a: UnitAnalysis): string | undefined {
  if (a.skipped === 'library') return 'library project: its users are outside the workspace, nothing is reported';
  if (a.skipped === 'no-tasks') return 'no tasks found, nothing can be reported as unused';
  if (!a.complete) return 'the analysis is not complete (a file cannot be read or a task call is unknown), nothing is reported';
  return undefined;
}

/** The tree description of a node: `unused` appended to the existing one when the node has a mark. */
export function treeDescription(mark: UnusedMark | undefined, base: string): string {
  if (!mark) return base;
  return base ? `${base} · unused` : 'unused';
}
