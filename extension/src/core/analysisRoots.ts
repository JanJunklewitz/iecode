// Entry points of the reachability analysis: what a PLC project runs or exposes without any textual call from other code.

import { parsePlcArchive } from './plcArchive';
import { NodeId, ObjectGraph, objectId } from './objectGraph';
import { SymbolIndex } from '../lang/index';

/** Raw file texts of the project and the configured patterns / pragma names. */
export interface RootSources { taskFiles: string[]; visuTexts: string[]; extra: string[]; rootPragmas: string[] }

export interface Root { id: NodeId; task?: string; why: 'task' | 'visualization' | 'configured' | 'pragma' | 'io' }

export const DEFAULT_ROOT_PRAGMAS = ['TcRpcEnable', 'call_after_init', 'call_after_global_init_slot', 'call_after_online_change_slot', 'OPC.UA.DA'];

/** `*` and `?` wildcards, case-insensitive, the whole name must match. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rootsOf(g: ObjectGraph, index: SymbolIndex, src: RootSources): { roots: Root[]; notes: string[]; noTasks: boolean; missingTaskCalls: string[]; badTaskFiles: number } {
  const roots: Root[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (r: Root) => { const k = `${r.id}|${r.task ?? ''}|${r.why}`; if (!seen.has(k)) { seen.add(k); roots.push(r); } };

  // 1. task calls
  let tasks = 0;
  const missingTaskCalls: string[] = [];
  let badTaskFiles = 0;
  for (const xml of src.taskFiles) {
    let task;
    try { task = parsePlcArchive(xml); } catch { notes.push('a task file could not be read'); badTaskFiles++; continue; }
    if (task.kind !== 'task') continue;
    tasks++;
    for (const call of task.calls) {
      const target = index.find(call.value);
      const id = target?.root ? objectId(target) : undefined;
      if (id && g.nodes.has(id)) add({ id, task: task.name, why: 'task' });
      else { notes.push(`task ${task.name} calls ${call.value}, which is not in the index`); missingTaskCalls.push(call.value); }
    }
  }
  const noTasks = tasks === 0;
  if (noTasks) notes.push('no tasks found, nothing can be reported as unused');

  const nodes = [...g.nodes.values()];

  // 2. names used in visualization files
  if (src.visuTexts.length) {
    const words = new Set<string>();
    for (const t of src.visuTexts) for (const w of t.match(/[A-Za-z_]\w*/g) ?? []) words.add(w.toUpperCase());
    for (const n of nodes) if (words.has(n.name.toUpperCase())) add({ id: n.id, why: 'visualization' });
  }
  notes.push('TcHMI projects are not scanned: objects used only by a TcHMI page may be reported as unused');

  // 3. configured names and globs (object name, member name or Object.Member)
  const globs = src.extra.map(globToRegExp);
  if (globs.length) for (const n of nodes) {
    const owner = n.owner ? g.nodes.get(n.owner)?.name : undefined;
    if (globs.some(r => r.test(n.name) || (owner && r.test(`${owner}.${n.name}`)))) add({ id: n.id, why: 'configured' });
  }

  // 4. pragmas in front of an object or member, and IO-linked variables
  const pragma = src.rootPragmas.length ? new RegExp(`\\{\\s*attribute\\s+'(?:${src.rootPragmas.map(escapeRe).join('|')})'`, 'i') : undefined;
  const monitoringCall = /\{\s*attribute\s+'monitoring'\s*:=\s*'call'/i;
  for (const n of nodes) {
    if (n.library) continue;
    const obj = index.get(n.file);
    if (!obj?.root) continue;
    const lines = obj.view.split('\n');
    let head: string;
    if (n.owner) {
      const m = obj.root.children.find(c => c.name.toUpperCase() === n.name.toUpperCase() && c.kind === n.kind);
      head = m ? lines.slice(m.full.line, m.range.line + 1).join('\n') : '';
    } else head = lines.slice(0, obj.root.range.line + 1).join('\n');
    if ((pragma && pragma.test(head)) || (n.kind === 'PROPERTY' && monitoringCall.test(head))) add({ id: n.id, why: 'pragma' });
    // a pragma on a variable of a GVL (OPC UA exposure) sits below the object header: look at its declaration lines
    if (!n.owner && n.kind === 'GVL' && pragma && obj.view.split('\n').some(l => !/^\s*\/\//.test(l) && pragma.test(l))) add({ id: n.id, why: 'pragma' });
    if (!n.owner && (n.kind === 'GVL' || n.kind === 'PROGRAM' || n.kind === 'FUNCTION_BLOCK') && /\bAT\s+%[IQ]/i.test(obj.view)) add({ id: n.id, why: 'io' });
  }
  return { roots, notes, noTasks, missingTaskCalls, badTaskFiles };
}
