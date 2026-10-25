// Workspace model: all TwinCAT solutions and loose PLC projects below the workspace folders,
// grouped into libraries / applications / standalone, with library dependencies between them.

import * as path from 'path';
import { findFiles, loadPlcProject, loadSolution, LibraryRef, PlcProject, Solution } from './projects';

export type Group = 'library' | 'application' | 'standalone';

/** One PLC project in the workspace, with where it comes from. */
export interface Unit {
  id: string;              // stable key: "<solution>/<plc>" or "<plc>" for standalone; "#2", "#3" … on clashes
  group: Group;
  plc: PlcProject;
  solution?: Solution;
}

export interface Edge {
  from: string;            // unit id that references the library
  to: string;              // unit id of the library project in the workspace
  ref: LibraryRef;
  /** 'workspace' when the reference resolves to the newest version (*) or to the same version as the
   *  library project; 'pinned' when it is fixed to another version. */
  link: 'workspace' | 'pinned';
}

export interface WorkspaceModel {
  solutions: Solution[];
  units: Unit[];
  edges: Edge[];
  errors: { file: string; message: string }[];
}

export async function discover(roots: string[]): Promise<WorkspaceModel> {
  const errors: WorkspaceModel['errors'] = [];
  const solutions: Solution[] = [];
  const seenPlc = new Set<string>();
  for (const root of roots) {
    for (const file of await findFiles(root, ['.sln'])) {
      try {
        const s = await loadSolution(file);
        if (s.projects.length === 0) continue;   // a .sln without TwinCAT projects (e.g. the CLI's own)
        solutions.push(s);
        for (const p of s.projects) for (const plc of p.plcs) seenPlc.add(norm(plc.file));
      } catch (e) {
        errors.push({ file, message: (e as Error).message });
      }
    }
  }

  const units: Unit[] = [];
  for (const s of solutions) {
    const lib = s.projects.some(p => p.plcs.some(plc => plc.isLibrary));
    for (const p of s.projects)
      for (const plc of p.plcs)
        units.push({ id: uniqueId(units, `${s.name}/${plc.name}`), group: lib ? 'library' : 'application', plc, solution: s });
  }
  for (const root of roots) {
    for (const file of await findFiles(root, ['.plcproj'])) {
      if (seenPlc.has(norm(file))) continue;
      try {
        const plc = await loadPlcProject(file);
        seenPlc.add(norm(file));
        units.push({ id: uniqueId(units, plc.name), group: plc.isLibrary ? 'library' : 'standalone', plc });
      } catch (e) {
        errors.push({ file, message: (e as Error).message });
      }
    }
  }
  return { solutions, units, edges: edgesOf(units), errors };
}

const norm = (f: string) => path.resolve(f).toLowerCase();
const uniqueId = (units: Unit[], name: string) => {
  let id = name, i = 2;
  while (units.some(u => u.id === id)) id = `${name}#${i++}`;
  return id;
};

/** Library projects in the workspace, by library title (case-insensitive). */
export function librariesByTitle(units: Unit[]): Map<string, Unit> {
  const m = new Map<string, Unit>();
  for (const u of units) if (u.plc.isLibrary && u.plc.title) m.set(u.plc.title.toLowerCase(), u);
  return m;
}

export function edgesOf(units: Unit[]): Edge[] {
  const libs = librariesByTitle(units);
  const edges: Edge[] = [];
  for (const u of units)
    for (const ref of u.plc.references) {
      const lib = libs.get(ref.effective.name.toLowerCase());
      if (!lib || lib.id === u.id) continue;
      const v = ref.effective.version;
      edges.push({ from: u.id, to: lib.id, ref, link: v === '*' || v === lib.plc.version ? 'workspace' : 'pinned' });
    }
  return edges;
}

/** Build order: libraries before the projects that use them. Throws on cycles. */
export function buildOrder(model: Pick<WorkspaceModel, 'units' | 'edges'>, only?: Set<string>): string[] {
  const ids = model.units.map(u => u.id).filter(id => !only || only.has(id));
  const deps = new Map(ids.map(id => [id, model.edges.filter(e => e.from === id && (!only || only.has(e.to))).map(e => e.to)]));
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`Library cycle: ${[...trail, id].join(' → ')}`);
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) visit(d, [...trail, id]);
    state.set(id, 'done');
    out.push(id);
  };
  for (const id of [...ids].sort()) visit(id, []);
  return out;
}

/** Units affected by a change in the given units: themselves and everything that uses them through a workspace link. */
export function affected(model: Pick<WorkspaceModel, 'edges'>, changed: string[]): Set<string> {
  const result = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of model.edges)
      if (e.link === 'workspace' && result.has(e.to) && !result.has(e.from)) { result.add(e.from); grew = true; }
  }
  return result;
}

/** Which unit owns a file (by folder of its .plcproj), for "affected by this change". */
export function unitOfFile(model: Pick<WorkspaceModel, 'units'>, file: string): Unit | undefined {
  const f = norm(file);
  return model.units
    .filter(u => f.startsWith(norm(u.plc.dir) + path.sep.toLowerCase()) || f === norm(u.plc.file))
    .sort((a, b) => b.plc.dir.length - a.plc.dir.length)[0];
}

/** Mermaid flowchart of the dependency graph (library → user). */
export function toMermaid(model: Pick<WorkspaceModel, 'units' | 'edges'>): string {
  const id = (s: string) => 'n' + s.replace(/[^A-Za-z0-9]/g, '_');
  const lines = ['flowchart TD'];
  for (const u of model.units) {
    const label = u.plc.isLibrary ? `${u.plc.title} ${u.plc.version}` : u.id;
    lines.push(`  ${id(u.id)}${u.plc.isLibrary ? `[("${label}")]` : `["${label}"]`}`);
  }
  for (const e of model.edges)
    lines.push(`  ${id(e.to)} ${e.link === 'workspace' ? '-->' : '-.->'}|${e.link === 'workspace' ? 'workspace' : 'pinned ' + e.ref.effective.version}| ${id(e.from)}`);
  return lines.join('\n');
}
