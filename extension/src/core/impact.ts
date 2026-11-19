// Impact of changing an object, member or variable: the tasks that reach it, its callers and the IO links
// that name it. Read-only; what could not be checked is said in `notes`.

import { NodeId, ObjectGraph, Reach, reachedFrom } from './objectGraph';
import type { IoLink } from './iolinks';
import { normalizeLinkPath, parsePlcLinkSide } from './ioLinkSymbols';
import { shortName } from './iotree';

export interface ImpactResult {
  target: NodeId;
  tasks: NodeId[];
  directCallers: { id: NodeId; line: number }[];
  /** Callers further away than the direct ones (distinct nodes). */
  transitiveCallers: number;
  ioLinks: IoLink[];
  notes: string[];
}

/** `main.bstart` from `TIPC^<plc>^<plc> Instance^PlcTask Inputs^MAIN.bStart`; undefined for another PLC project, safety links and IO sides. */
export function ioVariablePath(link: IoLink, plc: string): string | undefined {
  const side = parsePlcLinkSide(link.variable);
  return side && side.plc.toLowerCase() === plc.toLowerCase() ? normalizeLinkPath(side.path) : undefined;
}

/** Edges into `id`, plus the edges into the interface or base member it implements or overrides (a call through the interface runs it). */
function incoming(g: ObjectGraph, id: NodeId): { from: NodeId; line: number }[] {
  const keys = [id, ...[...g.implicit].filter(([, list]) => list.some(i => i.member === id)).map(([key]) => key)];
  return keys.flatMap(k => (g.in.get(k) ?? []).map(e => ({ from: e.from, line: e.line })));
}

export function impactOf(g: ObjectGraph, r: Reach, roots: NodeId[], target: NodeId, links: IoLink[] | undefined, plc: string, variable?: string): ImpactResult {
  const notes: string[] = [];
  const direct = incoming(g, target).filter(c => c.from !== target);
  const seenDirect = new Set<string>();
  const directCallers = direct.filter(c => !seenDirect.has(`${c.from}@${c.line}`) && !!seenDirect.add(`${c.from}@${c.line}`)).map(c => ({ id: c.from, line: c.line }));

  const near = new Set([target, ...directCallers.map(c => c.id)]);
  const far = new Set<NodeId>();
  for (let queue = directCallers.map(c => c.id); queue.length;) {
    for (const c of incoming(g, queue.shift()!)) {
      if (near.has(c.from) || far.has(c.from)) continue;
      far.add(c.from);
      queue.push(c.from);
    }
  }

  if (!roots.length) notes.push('no tasks found: reachability from tasks could not be checked');
  else if (!r.reachable.has(target)) notes.push('no task reaches this object');
  const tasks = reachedFrom(g, target, roots);

  let ioLinks: IoLink[] = [];
  if (!links) notes.push('IO links were not read');
  else if (variable) {
    const owner = g.nodes.get(variable.split('.')[0].toUpperCase());
    if (owner?.kind === 'FUNCTION_BLOCK') notes.push('member variable of a function block: instance paths not analysed');
    else {
      const v = normalizeLinkPath(variable);
      ioLinks = links.filter(l => { const p = ioVariablePath(l, plc); return p !== undefined && (p === v || p.startsWith(v + '.')); });
    }
  }
  return { target, tasks, directCallers, transitiveCallers: far.size, ioLinks, notes };
}

export interface ImpactRow { label: string; detail?: string; kind: 'task' | 'caller' | 'io' | 'note'; target?: { file: string; line: number } }

/** Flat list for a QuickPick: tasks, then callers, then IO links (IO side as label, PLC variable as detail), then notes. */
export function impactRows(g: ObjectGraph, r: ImpactResult): ImpactRow[] {
  const name = (id: NodeId) => {
    const n = g.nodes.get(id);
    if (!n) return id;
    const owner = n.owner ? g.nodes.get(n.owner) : undefined;
    return owner ? `${owner.name}.${n.name}` : n.name;
  };
  const rows: ImpactRow[] = [];
  for (const id of r.tasks) {
    const n = g.nodes.get(id);
    rows.push({ label: name(id), kind: 'task', target: n && { file: n.file, line: n.line } });
  }
  for (const c of r.directCallers) {
    const n = g.nodes.get(c.id);
    rows.push({ label: name(c.id), detail: `line ${c.line + 1}`, kind: 'caller', target: n && { file: n.file, line: c.line } });
  }
  for (const l of r.ioLinks) rows.push({ label: shortName(l.io), detail: shortName(l.variable), kind: 'io' });
  for (const n of r.notes) rows.push({ label: n, kind: 'note' });
  return rows;
}
