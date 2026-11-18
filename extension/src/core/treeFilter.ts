// Filter for the project tree: free words match object names, "@kind" words restrict the object type.

import { ObjectType, PlcObject } from './projects';

/** Short type names shown next to tree items; also the source of the filter's kind words. */
export const TYPE_SHORT: Partial<Record<ObjectType, string>> = { FUNCTION_BLOCK: 'FB', PROGRAM: 'PRG', FUNCTION: 'FUN', INTERFACE: 'ITF', ENUM: 'ENUM', STRUCT: 'STRUCT', UNION: 'UNION', ALIAS: 'ALIAS', GVL: 'GVL',
  TASK: 'task', TEXTLIST: 'texts', IMAGEPOOL: 'images', VISUMANAGER: 'visu settings' };

/** Lower-case one-word short names -> type. */
export const KIND_WORDS: Readonly<Record<string, ObjectType>> = Object.fromEntries(
  (Object.entries(TYPE_SHORT) as [ObjectType, string][])
    .filter(([, s]) => !s.includes(' '))
    .map(([t, s]) => [s.toLowerCase(), t]));

export interface TreeFilter { text: string; words: string[]; kinds: ObjectType[] }

/** undefined = no filter. */
export function parseTreeFilter(text: string): TreeFilter | undefined | { error: string } {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return undefined;
  const words: string[] = [];
  const kinds: ObjectType[] = [];
  for (const tok of tokens) {
    if (!tok.startsWith('@')) { words.push(tok.toLowerCase()); continue; }
    const kind = Object.prototype.hasOwnProperty.call(KIND_WORDS, tok.slice(1).toLowerCase()) ? KIND_WORDS[tok.slice(1).toLowerCase()] : undefined;
    if (!kind) return { error: `Unknown kind "${tok}". Kinds: ${Object.keys(KIND_WORDS).map(k => '@' + k).join(' ')}` };
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { text: text.trim(), words, kinds };
}

export function objectMatches(f: TreeFilter, o: Pick<PlcObject, 'name' | 'type'>): boolean {
  if (f.kinds.length && !f.kinds.includes(o.type)) return false;
  const name = o.name.toLowerCase();
  return f.words.every(w => name.includes(w));
}

/** Objects that match and every folder (rel path, '/' separated) on the way to one of them. */
export function visibleIn(f: TreeFilter, objects: readonly PlcObject[]): { objects: Set<PlcObject>; folders: Set<string> } {
  const out = { objects: new Set<PlcObject>(), folders: new Set<string>() };
  for (const o of objects) {
    if (!objectMatches(f, o)) continue;
    out.objects.add(o);
    const parts = o.rel.split('/');
    for (let i = 1; i < parts.length; i++) out.folders.add(parts.slice(0, i).join('/'));
  }
  return out;
}

export function filterMessage(f: TreeFilter, objectCount: number, projectCount: number): string {
  if (!objectCount) return `Filter "${f.text}": nothing found.`;
  return `Filter "${f.text}": ${objectCount} object${objectCount === 1 ? '' : 's'} in ${projectCount} project${projectCount === 1 ? '' : 's'}.`;
}
