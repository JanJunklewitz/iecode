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
    const word = tok.slice(1).toLowerCase();
    const kind = Object.prototype.hasOwnProperty.call(KIND_WORDS, word) ? KIND_WORDS[word] : undefined;
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

/** Id suffix that makes VS Code treat a node as new (and so expand it) while a filter is active. */
export const filterIdSuffix = (generation: number): string => `#f${generation}`;

export interface FilterTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

/**
 * Typing logic of the filter input box: changes apply after a pause, Enter applies at once
 * and only closes the box for a valid text, Escape drops the pending change.
 */
export class FilterTyping {
  private timer: unknown;
  private current = '';
  constructor(
    private readonly timers: FilterTimers,
    /** Called with the parsed filter (undefined = none) when a text parsed. */
    private readonly apply: (f: TreeFilter | undefined) => void,
    /** Called with an error text or undefined to clear the message. */
    private readonly showError: (msg: string | undefined) => void,
    private readonly delayMs = 200,
  ) {}

  change(text: string) {
    this.current = text;
    this.stop();
    this.timer = this.timers.set(() => { this.timer = undefined; this.run(); }, this.delayMs);
  }

  /** Applies the current text at once. Returns true when the box may close. */
  accept(): boolean {
    this.stop();
    return this.run();
  }

  /** Escape: drop the pending change so a late timer cannot re-apply it. */
  abandon() { this.stop(); }

  private stop() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private run(): boolean {
    const f = parseTreeFilter(this.current);
    if (f && 'error' in f) { this.showError(f.error); return false; }
    this.showError(undefined);
    this.apply(f);
    return true;
  }
}

/** Words (any order, any case) and kinds that decide what is shown; `undefined` is the empty key. */
const filterKey = (f: TreeFilter | undefined) =>
  f ? `${[...new Set(f.words.map(w => w.toLowerCase()))].sort().join(' ')}|${[...new Set(f.kinds)].sort().join(',')}` : '';

/** True when applying b over a would not change what is shown: the same words and kinds, however they were typed. */
export const sameFilter = (a: TreeFilter | undefined, b: TreeFilter | undefined): boolean => filterKey(a) === filterKey(b);
