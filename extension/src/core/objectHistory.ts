// History of one method, property, action or whole object, following renames.
// `git log -L` cannot see sections inside the XML, so the section texts are compared commit by commit
// (each commit with its first parent, never with its neighbour in the log: parallel branches interleave there).

import { blobsAt, historyCommits } from './git';
import { decode, nonStBodies, parseView, sectionsOfXml } from '../model';
import { pairRenames } from './renameMatch';

export interface HistoryEntry {
  commit: string; short: string; date: string; author: string; subject: string;
  key: string;
  change: 'added' | 'changed' | 'renamed' | 'removed' | 'unreadable';
  renamedFrom?: string;
  merge?: boolean;
  before?: string;
  after?: string;
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** The keys that make up one identity: a property is PROPERTY, GET and SET together. */
function group(key: string): string[] {
  const [kind, name] = key.split(/:(.*)/s);
  return kind === 'PROPERTY' || kind === 'GET' || kind === 'SET' ? [`PROPERTY:${name}`, `GET:${name}`, `SET:${name}`] : [key];
}

/**
 * Text of one section, for a property of its three parts joined. The raw XML of a non-ST body is appended, because the
 * view shows only a marker line for CFC / FBD / SFC and a change there would otherwise be invisible.
 */
export function sectionTextOf(xml: string, view: string, key: string): string | undefined {
  const keys = group(key);
  const parts = parseView(view).filter(s => keys.includes(s.key));
  if (!parts.length) return undefined;
  const raw = nonStBodies(xml);
  return parts.map(s => [s.decl ?? '', s.impl ?? '', raw.get(s.key) ?? ''].join('\n')).join('\n');
}

interface Decoded { xml: string; view: string; ids: Map<string, string>; keys: string[] }

function decodeFile(text: string | undefined): Decoded | 'unreadable' | undefined {
  if (text === undefined) return undefined;
  try {
    const xml = stripBom(text);
    const view = decode(xml);
    parseView(view);                                   // a duplicate section throws
    const secs = sectionsOfXml(xml);
    return { xml, view, ids: new Map(secs.map(s => [s.key, s.node.attrs.Id ?? ''])), keys: secs.map(s => s.key) };
  } catch { return 'unreadable'; }
}

/** Text of a whole object: the ST view plus the raw XML of every non-ST body. */
export const fileTextOf = (xml: string) => [decode(xml), ...[...nonStBodies(xml)].map(([k, v]) => `${k}\n${v}`)].join('\n');
const wholeText = (d: Decoded) => fileTextOf(d.xml);

export async function objectHistory(root: string, file: string, key: string | 'FILE', max = 200): Promise<{ entries: HistoryEntry[]; cut: boolean }> {
  const all = await historyCommits(root, file, max + 1);
  const cut = all.length > max;
  const commits = all.slice(0, max);
  const blobs = await blobsAt(root, commits.flatMap(c => [
    { ref: c.commit.hash, file: c.path },
    { ref: `${c.commit.hash}^`, file: c.parentPath ?? c.path },
  ]));
  const entries: HistoryEntry[] = [];
  let followed: string | undefined = key === 'FILE' ? key : group(key)[0];
  for (const c of commits) {
    if (followed === undefined) break;
    const base = { commit: c.commit.hash, short: c.commit.short, date: c.commit.date, author: c.commit.author, subject: c.commit.subject, merge: c.parents > 1 || undefined };
    const child = decodeFile(blobs.get(`${c.commit.hash}:${c.path}`));
    const parent = decodeFile(blobs.get(`${c.commit.hash}^:${c.parentPath ?? c.path}`));
    if (child === 'unreadable' || parent === 'unreadable') { entries.push({ ...base, key: followed, change: 'unreadable' }); continue; }
    if (!child) continue;                              // the file does not exist in this commit (a deletion): nothing to compare

    if (followed === 'FILE') {
      const after = wholeText(child), before = parent ? wholeText(parent) : undefined;
      if (before !== after) entries.push({ ...base, key: 'FILE', change: before === undefined ? 'added' : 'changed', before, after });
      continue;
    }

    const textIn = (d: Decoded, k: string) => sectionTextOf(d.xml, d.view, k);
    const after = textIn(child, followed);
    const idOf = (d: Decoded, k: string) => d.ids.get(k) || undefined;
    const childId = idOf(child, followed);

    // the same member in the parent: by Id first (same Id under another name is a rename), then by name if the Id agrees
    let pkey: string | undefined;
    const kind: string = followed.split(':')[0];
    if (parent && after !== undefined) {
      const byId = childId ? parent.keys.find(k => k.startsWith(kind + ':') && idOf(parent, k) === childId) : undefined;
      if (byId) pkey = byId;
      else if (parent.keys.includes(followed)) {
        const pid = idOf(parent, followed);
        if (!childId || !pid || pid === childId) pkey = followed;
      }
      if (!pkey) {
        // unrelated Id: a rename the Id cannot show (member re-created) is recognised by text similarity
        const gone: string[] = parent.keys.filter(k => k.startsWith(kind + ':') && !child.keys.includes(k));
        // every new member of the kind competes for the removed ones, so that an exact replacement is not taken from under it by a similar newcomer
        const added = child.keys.filter(k => k.startsWith(kind + ':') && !parent.keys.includes(k)).map(k => ({ k, t: textIn(child, k) ?? '' }));
        const pair = pairRenames(gone.map(k => ({ k, t: textIn(parent, k) ?? '' })), added, i => i.t).find(p => p.to.k === followed);
        if (pair) pkey = pair.from.k;
      }
    } else if (parent && after === undefined && textIn(parent, followed) !== undefined) {
      pkey = followed;
    }

    const before = parent && pkey ? textIn(parent, pkey) : undefined;
    if (after !== undefined && before === undefined) {
      entries.push({ ...base, key: followed, change: 'added', after });
      followed = undefined;                            // older commits belong to a different identity
    } else if (after === undefined && before !== undefined) {
      entries.push({ ...base, key: followed, change: 'removed', before });
    } else if (after !== undefined && before !== undefined) {
      if (pkey !== followed) entries.push({ ...base, key: followed, change: 'renamed', renamedFrom: pkey, before, after });
      else if (before !== after) entries.push({ ...base, key: followed, change: 'changed', before, after });
      followed = pkey!;
    }
  }
  return { entries, cut };
}

/** Label and description of one history entry for the list. */
export function historyItemLabel(e: HistoryEntry): { label: string; description: string } {
  if (e.change === 'unreadable') return { label: `${e.short}  ${e.subject}`, description: `${e.author}, ${e.date}, not readable` };
  const extra = [e.renamedFrom ? `renamed from ${e.renamedFrom.split(':')[1] ?? e.renamedFrom}` : '', e.merge ? 'merge' : ''].filter(Boolean);
  return { label: `${e.short}  ${e.subject}`, description: [`${e.author}, ${e.date}`, ...extra].join(', ') };
}
