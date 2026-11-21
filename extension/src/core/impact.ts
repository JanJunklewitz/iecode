// Impact of changing an object, member or variable: the tasks that reach it, its callers and the IO links
// that name it. Read-only; what could not be checked is said in `notes`.

import { NodeId, ObjectGraph, Reach, reachedFrom } from './objectGraph';
import type { IoLink } from './iolinks';
import { normalizeLinkPath, parsePlcLinkSide } from './ioLinkSymbols';
import { shortName } from './iotree';

export interface ImpactResult {
  target: NodeId;
  tasks: NodeId[];
  /** `nonSt`: the reference comes from a CFC, SFC or other non-ST body and has no line. */
  directCallers: { id: NodeId; line: number; nonSt?: boolean }[];
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

/** For each member: the interface or base members it implements or overrides (a call through those runs it). */
function implicitKeys(g: ObjectGraph): Map<NodeId, NodeId[]> {
  const keys = new Map<NodeId, NodeId[]>();
  for (const [key, list] of g.implicit) for (const i of list) keys.set(i.member, [...(keys.get(i.member) ?? []), key]);
  return keys;
}

/** Edges into `id`, plus the edges into the interface or base member it implements or overrides. */
function incoming(g: ObjectGraph, via: Map<NodeId, NodeId[]>, id: NodeId): { from: NodeId; line: number; nonSt: boolean }[] {
  return [id, ...(via.get(id) ?? [])].flatMap(k => (g.in.get(k) ?? []).map(e => ({ from: e.from, line: e.line, nonSt: e.reason === 'non-st' })));
}

export function impactOf(g: ObjectGraph, r: Reach, roots: NodeId[], target: NodeId, links: IoLink[] | undefined, plc: string, variable?: string): ImpactResult {
  const notes: string[] = [];
  const via = implicitKeys(g);
  const direct = incoming(g, via, target).filter(c => c.from !== target);
  const seenDirect = new Set<string>();
  const directCallers = direct.filter(c => !seenDirect.has(`${c.from}@${c.line}`) && !!seenDirect.add(`${c.from}@${c.line}`)).map(c => ({ id: c.from, line: c.line, ...(c.nonSt ? { nonSt: true } : {}) }));

  const near = new Set([target, ...directCallers.map(c => c.id)]);
  const far = new Set<NodeId>();
  for (let queue = directCallers.map(c => c.id); queue.length;) {
    for (const c of incoming(g, via, queue.shift()!)) {
      if (near.has(c.from) || far.has(c.from)) continue;
      far.add(c.from);
      queue.push(c.from);
    }
  }

  if (!roots.length) notes.push('no tasks found: reachability from tasks could not be checked');
  else if (!r.reachable.has(target)) notes.push('no task reaches this object');
  const tasks = reachedFrom(g, target, roots);
  const how = r.reachable.get(target)?.reason;
  if (how === 'by-name' && !directCallers.length) notes.push('reached only through a name match: callers are not listed');
  else if (roots.length && r.reachable.has(target) && !tasks.length) notes.push('not reached from a task, only from other roots (visualization, pragma, IO link or configured object)');

  let ioLinks: IoLink[] = [];
  const node = g.nodes.get(target);
  // an object target is a variable prefix only where instance paths equal the object name
  const path = variable ?? (node && !node.owner && (node.kind === 'GVL' || node.kind === 'PROGRAM') ? node.name : undefined);
  if (!links) notes.push('IO links were not read');
  else if (!path) notes.push('IO links are only checked for variables, GVLs and programs');
  else {
    const owner = g.nodes.get(path.split('.')[0].toUpperCase());
    if (owner && owner.kind !== 'GVL' && owner.kind !== 'PROGRAM') notes.push(`member of a ${owner.kind.toLowerCase().replace('_', ' ')}: instance paths not analysed`);
    else {
      const v = normalizeLinkPath(path);
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
    rows.push(c.nonSt
      ? { label: name(c.id), detail: 'non-ST body', kind: 'caller', target: n && { file: n.file, line: n.line } }
      : { label: name(c.id), detail: `line ${c.line + 1}`, kind: 'caller', target: n && { file: n.file, line: c.line } });
  }
  for (const l of r.ioLinks) rows.push({ label: shortName(l.io), detail: shortName(l.variable), kind: 'io' });
  for (const n of r.notes) rows.push({ label: n, kind: 'note' });
  return rows;
}
