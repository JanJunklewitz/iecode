// One SymbolIndex per PLC project, built from the files on disk.
// The editor index of lang/providers.ts is workspace-wide and keyed by object name, so two applications that both
// have MAIN or a GVL of the same name would resolve into each other; analyses and lint rules need per-project resolution.

import { decode } from '../model';
import { IndexedObject, SymbolIndex, indexObject } from '../lang/index';
import { Unit, WorkspaceModel } from './workspace';

export interface UnitIndexInput {
  /** File text, or undefined when it cannot be read. */
  readFile(file: string): Promise<string | undefined>;
  /** Views of the compiled library sources the unit uses (references and what they reference). */
  libraryObjects(unit: Unit): { key: string; view: string; library: string }[];
  /** Namespace or placeholder name (upper or lower case) to library name. */
  namespaces(unit: Unit): Map<string, string>;
  /** Parsed library objects, shared between unit indexes (a library view is parsed once, not once per unit). */
  parsed?: Map<string, IndexedObject>;
}

export type SkipReason = 'unreadable' | 'encrypted' | 'not-st';

/** Object types that are source objects with a declaration (tasks, visualizations, text lists ... are not). */
const SOURCE_TYPES = new Set(['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'STRUCT', 'ENUM', 'UNION', 'ALIAS', 'GVL']);

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** The workspace library projects a unit uses through a `workspace` link, transitively. A `pinned` edge uses the compiled library instead. */
function workspaceLibraries(unit: Unit, model: Pick<WorkspaceModel, 'units' | 'edges'>): Unit[] {
  const out = new Map<string, Unit>();
  const queue = [unit.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of model.edges) {
      if (e.from !== id || e.link !== 'workspace' || out.has(e.to) || e.to === unit.id) continue;
      const u = model.units.find(x => x.id === e.to);
      if (u) { out.set(u.id, u); queue.push(u.id); }
    }
  }
  return [...out.values()];
}

/**
 * The index holds the unit's own object files, the object files of the workspace library projects it references with a
 * `workspace` link (marked as library objects: they are never reported) and the compiled library sources. Files that cannot
 * be read, are encrypted or do not decode are returned in `skipped`; they make an analysis incomplete.
 */
export async function buildUnitIndex(unit: Unit, model: Pick<WorkspaceModel, 'units' | 'edges'>, input: UnitIndexInput, notes: string[]):
  Promise<{ index: SymbolIndex; skipped: { file: string; reason: SkipReason }[] }> {
  const index = new SymbolIndex();
  const skipped: { file: string; reason: SkipReason }[] = [];
  index.setNamespaces(input.namespaces(unit));

  const addUnit = async (u: Unit, library?: string) => {
    for (const o of u.plc.objects) {
      if (!SOURCE_TYPES.has(o.type)) continue;
      if (o.encrypted) { skipped.push({ file: o.file, reason: 'encrypted' }); continue; }
      const text = await input.readFile(o.file);
      if (text === undefined) { skipped.push({ file: o.file, reason: 'unreadable' }); continue; }
      try {
        // a file that decodes but has no parsed root (an empty declaration) would drop its calls from the graph unnoticed
        if (!index.update(o.file, decode(stripBom(text)), library).root) skipped.push({ file: o.file, reason: 'not-st' });
      } catch { skipped.push({ file: o.file, reason: 'not-st' }); }
    }
  };
  await addUnit(unit);
  for (const lib of workspaceLibraries(unit, model)) {
    await addUnit(lib, lib.plc.title ?? lib.plc.name);
  }
  for (const l of input.libraryObjects(unit)) {
    const cached = input.parsed?.get(l.key);
    if (cached && cached.view === l.view) index.add(cached);
    else {
      // one malformed library view must not take the whole analysis down
      try {
        const obj = indexObject(l.key, l.view, l.library);
        input.parsed?.set(l.key, obj);
        index.add(obj);
      } catch { skipped.push({ file: l.key, reason: 'not-st' }); }
    }
  }
  if (skipped.length) notes.push(`${skipped.length} file(s) could not be analysed (unreadable, encrypted or not a PLC object)`);
  return { index, skipped };
}
