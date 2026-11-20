// Display data for unused objects: the tree, the editor hints and the list command show the same set.

import type { NodeId } from './objectGraph';
import type { AnalysisState, UnitAnalysis } from './analysisState';

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
  for (const k of marks) {
    const list = m.get(k.file);
    if (list) list.push(k); else m.set(k.file, [k]);
  }
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

/** What the project tree asks: the mark of a node, and a nudge to compute a unit's analysis. */
export interface UnusedLookup {
  markOf(unitId: string, nodeId: string): UnusedMark | undefined;
  ensure(unitId: string): void;
}

export class UnusedMarks implements UnusedLookup {
  private readonly memo = new WeakMap<UnitAnalysis, Map<string, UnusedMark>>();
  private readonly byFileMemo = new WeakMap<UnitAnalysis, Map<string, UnusedMark[]>>();
  private disposed = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly analysis: Pick<AnalysisState, 'peek' | 'request'>, private readonly enabled: () => boolean, private readonly delayMs = 300) {}

  private marksOf(a: UnitAnalysis) {
    let m = this.memo.get(a);
    if (!m) { m = new Map(unusedMarks(a).map(k => [k.id, k])); this.memo.set(a, m); }
    return m;
  }

  markOf(unitId: string, nodeId: string): UnusedMark | undefined {
    if (!this.enabled()) return undefined;
    const a = this.analysis.peek(unitId);
    return a && !emptyReason(a) ? this.marksOf(a).get(nodeId.toUpperCase()) : undefined;
  }

  /** Starts the computation for a unit when marks are on; debounced, and AnalysisState deduplicates running requests. */
  ensure(unitId: string): void {
    if (this.disposed || !this.enabled() || this.analysis.peek(unitId) || this.timers.has(unitId)) return;
    this.timers.set(unitId, setTimeout(() => { this.timers.delete(unitId); void this.analysis.request(unitId).catch(e => console.warn(`IECode: analysis of ${unitId} failed: ${(e as Error).message}`)); }, this.delayMs));
  }

  marksByFileOf(unitId: string): Map<string, UnusedMark[]> {
    const a = this.analysis.peek(unitId);
    if (!a || emptyReason(a)) return new Map();
    let m = this.byFileMemo.get(a);
    if (!m) { m = marksByFile([...this.marksOf(a).values()]); this.byFileMemo.set(a, m); }
    return m;
  }

  dispose() { this.disposed = true; this.timers.forEach(clearTimeout); this.timers.clear(); }
}
