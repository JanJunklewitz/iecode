// The object graph per PLC project, kept up to date. No VS Code API: everything comes in through `AnalysisDeps`,
// so the analysis can be tested and the extension wires it to the workspace model and the library sources.

import { nonStBodies } from '../model';
import { fileEdges, assemble, findUnused, reach, NodeId, ObjectGraph, Reach, UnusedFinding, objectId } from './objectGraph';
import { rootsOf, Root } from './analysisRoots';
import { buildUnitIndex, UnitIndexInput } from './unitIndex';
import { Unit, WorkspaceModel } from './workspace';
import type { IndexedObject } from '../lang/index';

export interface AnalysisDeps extends Omit<UnitIndexInput, 'readFile'> {
  model(): Pick<WorkspaceModel, 'units' | 'edges'>;
  /** File text and a stamp that changes when the file does (mtime and size), or undefined when it cannot be read. */
  read(file: string): Promise<{ text: string; stamp: string } | undefined>;
  settings(): { rootObjects: string[]; rootPragmas: string[] };
}

export interface UnitAnalysis {
  unit: string;
  graph: ObjectGraph;
  reach: Reach;
  roots: Root[];
  unused: UnusedFinding[];
  notes: string[];
  /** False when a file of the unit failed to decode, is encrypted, or a task call names no node: then no unused finding is produced. */
  complete: boolean;
  skipped?: 'library' | 'no-tasks';
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const emptyGraph = (): ObjectGraph => ({ nodes: new Map(), out: new Map(), in: new Map(), byNameUnresolved: new Map(), implicit: new Map(), contract: new Set() });

export class AnalysisState {
  private readonly cache = new Map<string, UnitAnalysis>();
  private readonly running = new Map<string, Promise<UnitAnalysis>>();
  private readonly files = new Map<string, { stamp: string; text: string }>();
  private readonly parsed = new Map<string, IndexedObject>();
  private readonly listeners = new Set<(ids: string[]) => void>();
  private disposed = false;

  constructor(private readonly deps: AnalysisDeps, private readonly sliceSize = 25) {}

  /** Cached result, or undefined; never blocks. */
  peek(unitId: string): UnitAnalysis | undefined { return this.cache.get(unitId); }

  onDidChange(listener: (ids: string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Forgets cached results (all, or one unit); the next request recomputes. Trigger on a file-watcher event or a save, never on a keystroke. */
  invalidate(unitId?: string) {
    if (unitId) this.cache.delete(unitId); else this.cache.clear();
  }

  dispose() { this.disposed = true; this.listeners.clear(); this.cache.clear(); }

  /** Computes if needed, in slices that yield to the event loop; honours an abort signal (the result is then not cached). */
  request(unitId: string, signal?: AbortSignal): Promise<UnitAnalysis> {
    const hit = this.cache.get(unitId);
    if (hit) return Promise.resolve(hit);
    let p = this.running.get(unitId);
    if (!p) {
      p = this.compute(unitId, signal).then(r => {
        if (!signal?.aborted && !this.disposed) { this.cache.set(unitId, r); this.listeners.forEach(l => l([unitId])); }
        return r;
      }).finally(() => { this.running.delete(unitId); });
      this.running.set(unitId, p);
    }
    return p;
  }

  /** Text of a file, from the cache when its stamp is unchanged. */
  private async read(file: string): Promise<string | undefined> {
    const r = await this.deps.read(file);
    if (!r) { this.files.delete(file); return undefined; }
    const c = this.files.get(file);
    if (c?.stamp === r.stamp) return c.text;
    this.files.set(file, r);
    return r.text;
  }

  private async compute(unitId: string, signal?: AbortSignal): Promise<UnitAnalysis> {
    const model = this.deps.model();
    const unit = model.units.find(u => u.id === unitId);
    const base = { unit: unitId, graph: emptyGraph(), reach: { reachable: new Map() } as Reach, roots: [] as Root[], unused: [] as UnusedFinding[], notes: [] as string[] };
    if (!unit) return { ...base, notes: ['unknown project'], complete: false };
    if (unit.plc.isLibrary) return { ...base, notes: ['library project: its users are outside the workspace, nothing is reported'], complete: true, skipped: 'library' };

    const notes: string[] = [];
    const { index, skipped } = await buildUnitIndex(unit, model, { ...this.deps, readFile: f => this.read(f), parsed: this.parsed }, notes);
    const files = [];
    let n = 0;
    for (const obj of index.objects()) {
      if (signal?.aborted) break;
      let nonSt: Map<string, string> | undefined;
      if (!obj.library) {
        const text = await this.read(obj.file);
        if (text !== undefined) { try { nonSt = nonStBodies(stripBom(text)); } catch { /* decoded before, cannot fail */ } }
      }
      files.push(fileEdges(index, obj, nonSt, { nodesOnly: !!obj.library }));
      if (++n % this.sliceSize === 0) await new Promise<void>(r => setImmediate(r));
    }
    const graph = assemble(files, index);

    const taskFiles: string[] = [], visuTexts: string[] = [];
    for (const o of unit.plc.objects) {
      const kind = o.type === 'TASK' ? taskFiles : /\.tcvis$/i.test(o.file) ? visuTexts : undefined;
      const text = kind ? await this.read(o.file) : undefined;
      if (kind && text !== undefined) kind.push(text);
    }
    const s = this.deps.settings();
    const r = rootsOf(graph, index, { taskFiles, visuTexts, extra: s.rootObjects, rootPragmas: s.rootPragmas });
    notes.push(...r.notes);
    const rc = reach(graph, r.roots.map(x => x.id));

    // a task call into a library namespace without source is a note; any other missing call hides callees
    const hidden = r.missingTaskCalls.filter(c => !(c.includes('.') && index.namespace(c.slice(0, c.indexOf('.')))));
    const complete = skipped.length === 0 && hidden.length === 0;
    if (!complete && hidden.length) notes.push(`not complete: task call(s) ${hidden.join(', ')} name no object`);
    if (!complete && skipped.length) notes.push('not complete: unused objects are not reported while files cannot be analysed');
    if (r.noTasks) return { unit: unitId, graph, reach: rc, roots: r.roots, unused: [], notes, complete, skipped: 'no-tasks' };
    return { unit: unitId, graph, reach: rc, roots: r.roots, unused: complete ? findUnused(graph, rc) : [], notes, complete };
  }
}

export type { NodeId, Unit };
export { objectId };
