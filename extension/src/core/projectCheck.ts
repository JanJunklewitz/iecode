// Checks a .plcproj against the files on disk and repairs it. A .plcproj gets out of step when TwinCAT XAE
// doesn't save the project properly (or files are changed by hand / by git): entries of files that no
// longer exist, duplicates, entries with the wrong case, object files no entry lists.
// Pure text edits on top of plcproj.ts / projectFiles.ts: everything the repair doesn't touch stays byte-identical.

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseXml, XNode } from '../xml';
import { includeValue, removeElement } from './plcproj';
import { isTcObjectFile, registerPaths } from './projectFiles';

/** Files and folders below a PLC project folder, '/'-separated, in the case they have on disk. */
export interface DiskTree { files: string[]; folders: string[] }

export type EntryKind = 'Compile' | 'None' | 'Folder';

/** An <X Include="…"> item of the project file, with its offsets in the text. */
export interface Entry {
  kind: EntryKind;
  /** The path, '/'-separated, without a trailing separator. */
  rel: string;
  /** The element. */
  start: number; end: number;
  /** The attribute value (raw, between the quotes). */
  valueStart: number; valueEnd: number;
  /** Folder written with a trailing backslash ("POUs\"). */
  trailingSlash: boolean;
}

export type IssueCode = 'missing-file' | 'missing-folder' | 'duplicate' | 'case-mismatch' | 'unlisted';

export interface Issue {
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
  /** Range in the text to underline. */
  start: number; end: number;
  /** The entry (not set for 'unlisted'). */
  entry?: Entry;
  /** The entry's path, or the unlisted file. */
  rel: string;
  /** 'case-mismatch': the path as on disk. 'missing-file': the file it was probably moved to. */
  actual?: string;
  /** 'duplicate': the first entry. */
  first?: Entry;
}

const ENTRY_KINDS = new Set<string>(['Compile', 'None', 'Folder']);
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj']);
const toPosix = (p: string) => p.replace(/\\/g, '/');
const win = (rel: string) => rel.replace(/\//g, '\\');
const lower = (s: string) => s.toLowerCase();
const skippedDir = (name: string) => name.startsWith('_') || name.startsWith('.') || SKIP_DIRS.has(name);

/**
 * Paths the check doesn't judge: outside the project folder, absolute, with wildcards or MSBuild properties,
 * or below folders the disk scan skips (TwinCAT output `_*`, hidden folders).
 */
function unchecked(rel: string): boolean {
  if (!rel || /[*?$]/.test(rel) || /^[A-Za-z]:|^\//.test(rel)) return true;
  const dirs = rel.split('/').slice(0, -1);
  return dirs.some(d => d === '..' || skippedDir(d));
}

function* walk(n: XNode): Generator<XNode> { for (const c of n.children) { yield c; yield* walk(c); } }

/** The Compile, None and Folder items of a project file, in document order. Throws when the XML can't be parsed. */
export function listEntries(text: string): Entry[] {
  const out: Entry[] = [];
  for (const n of walk(parseXml(text))) {
    if (!ENTRY_KINDS.has(n.name) || n.attrs.Include === undefined) continue;
    const tag = text.slice(n.start, n.innerStart);
    const m = /\sInclude\s*=\s*"/.exec(tag);
    if (!m) continue;
    const valueStart = n.start + m.index + m[0].length;
    const valueEnd = text.indexOf('"', valueStart);
    const raw = toPosix(n.attrs.Include);
    out.push({ kind: n.name as EntryKind, rel: raw.replace(/\/+$/, ''), start: n.start, end: n.end, valueStart, valueEnd, trailingSlash: raw.endsWith('/') });
  }
  return out;
}

/** Where "not in the project" is reported: the <ItemGroup> of the Compile items, else the first one, else <Project>. */
function unlistedAnchor(text: string): { start: number; end: number } {
  const all = [...walk(parseXml(text))];
  const groups = all.filter(n => n.name === 'ItemGroup');
  const n = groups.find(g => g.children.some(c => c.name === 'Compile')) ?? groups[0] ?? all.find(c => c.name === 'Project');
  return n ? { start: n.start, end: n.innerStart } : { start: 0, end: 0 };
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

/** Checks a project file against the files and folders below its folder. */
export function checkProject(text: string, disk: DiskTree): Issue[] {
  const entries = listEntries(text);
  const files = new Map<string, string>(), folders = new Map<string, string>();
  for (const f of disk.files) if (!files.has(lower(f))) files.set(lower(f), f);
  for (const f of disk.folders) if (!folders.has(lower(f))) folders.set(lower(f), f);

  const issues: Issue[] = [];
  const seen = new Map<string, Entry>();
  const listed = new Set<string>();
  for (const e of entries) {
    const shown = win(e.rel);
    const at = { start: e.valueStart, end: e.valueEnd, entry: e, rel: e.rel };
    if (e.kind === 'Compile') listed.add(lower(e.rel));
    const key = `${e.kind === 'Folder' ? 'Folder' : 'File'}:${lower(e.rel)}`;
    const first = seen.get(key);
    if (first) {
      issues.push({ ...at, code: 'duplicate', severity: 'warning', first, message: `Duplicate entry: ${shown} is already listed on line ${lineOf(text, first.start)}.` });
      continue;
    }
    seen.set(key, e);
    if (unchecked(e.rel)) continue;
    const actual = (e.kind === 'Folder' ? folders : files).get(lower(e.rel));
    if (!actual) {
      issues.push(e.kind === 'Folder'
        ? { ...at, code: 'missing-folder', severity: 'warning', message: `Folder not found: ${shown}` }
        : { ...at, code: 'missing-file', severity: e.kind === 'Compile' ? 'error' : 'warning', message: `File not found: ${shown}` });
    } else if (actual !== e.rel) {
      issues.push({ ...at, code: 'case-mismatch', severity: 'warning', actual, message: `Case differs from the ${e.kind === 'Folder' ? 'folder' : 'file'} on disk: ${shown} is ${win(actual)}` });
    }
  }

  const unlisted = disk.files.filter(f => isTcObjectFile(f) && !listed.has(lower(f)) && !unchecked(f)).sort();
  // a missing Compile entry and an unlisted file of the same name (and no other): the file was moved
  const byName = <T>(xs: T[], rel: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) { const k = lower(path.posix.basename(rel(x))); m.set(k, [...(m.get(k) ?? []), x]); }
    return m;
  };
  const missing = byName(issues.filter(i => i.code === 'missing-file' && i.entry!.kind === 'Compile'), i => i.rel);
  const candidates = byName(unlisted, f => f);
  const moved = new Set<string>();
  for (const [name, [issue, ...more]] of missing) {
    const target = candidates.get(name);
    if (more.length || target?.length !== 1) continue;
    issue.actual = target[0];
    issue.message += ` (moved to ${win(target[0])}?)`;
    moved.add(target[0]);
  }

  const anchor = unlistedAnchor(text);
  for (const f of unlisted) {
    if (moved.has(f)) continue;
    issues.push({ ...anchor, code: 'unlisted', severity: 'warning', rel: f, message: `Not in the project: ${win(f)} (TwinCAT neither shows nor compiles it)` });
  }
  return issues;
}

/** What a single issue can be fixed with. */
export type FixKind = 'remove' | 'rename' | 'add';

/** The fixes offered for an issue, most likely first. */
export function fixesFor(issue: Issue): FixKind[] {
  switch (issue.code) {
    case 'missing-file': return issue.actual ? ['rename', 'remove'] : ['remove'];
    case 'missing-folder': case 'duplicate': return ['remove'];
    case 'case-mismatch': return ['rename'];
    case 'unlisted': return ['add'];
  }
}

/** Title of a fix in the quick fix menu. */
export function fixTitle(issue: Issue, fix: FixKind): string {
  if (fix === 'add') return `Add <Compile Include="${win(issue.rel)}"> to the project`;
  if (fix === 'rename') return `Change the path to ${win(issue.actual!)}`;
  return issue.code === 'duplicate' ? 'Remove the duplicate entry' : `Remove the entry of ${win(issue.rel)}`;
}

const setPath = (text: string, e: Entry, rel: string) =>
  text.slice(0, e.valueStart) + includeValue(rel) + (e.trailingSlash ? '\\' : '') + text.slice(e.valueEnd);

/** Parent folder of a moved / added file, when it needs an entry. */
const dirOf = (rel: string) => { const d = path.posix.dirname(rel); return d === '.' ? [] : [d]; };

/** Applies one fix of one issue (found in this text). */
export function applyFix(text: string, issue: Issue, fix: FixKind): string {
  if (fix === 'add') return registerPaths(text, [issue.rel]);
  const e = issue.entry!;
  if (fix === 'remove') return removeElement(text, e.start, e.end);
  const out = setPath(text, e, issue.actual!);
  return issue.code === 'missing-file' ? registerPaths(out, [], dirOf(issue.actual!)) : out;
}

export interface ResolveResult {
  text: string;
  /** Entries removed: stale (file / folder not found) and duplicates. */
  removed: { kind: EntryKind; rel: string; reason: 'missing' | 'duplicate' }[];
  /** Entries pointed to a moved file, or to the path's case on disk. */
  changed: { from: string; to: string; reason: 'moved' | 'case' }[];
  /** Compile entries added for unlisted object files. */
  added: string[];
  /** Folder entries added for them. */
  addedFolders: string[];
}

const folderSet = (text: string) => new Set(listEntries(text).filter(e => e.kind === 'Folder').map(e => lower(e.rel)));

/**
 * Repairs the whole project file in one go: removes stale and duplicate entries, fixes the case of paths,
 * follows moved files, and adds unlisted object files with the folders they need.
 */
export function resolveProject(text: string, disk: DiskTree): ResolveResult {
  const issues = checkProject(text, disk);
  const result: ResolveResult = { text, removed: [], changed: [], added: [], addedFolders: [] };
  const edits: { at: number; apply: (t: string) => string }[] = [];
  const newFolders: string[] = [];
  for (const i of issues) {
    const e = i.entry;
    if (!e) { result.added.push(i.rel); continue; }
    if (i.actual) {
      result.changed.push({ from: e.rel, to: i.actual, reason: i.code === 'missing-file' ? 'moved' : 'case' });
      if (i.code === 'missing-file') newFolders.push(...dirOf(i.actual));
      edits.push({ at: e.valueStart, apply: t => setPath(t, e, i.actual!) });
    } else {
      result.removed.push({ kind: e.kind, rel: e.rel, reason: i.code === 'duplicate' ? 'duplicate' : 'missing' });
      edits.push({ at: e.start, apply: t => removeElement(t, e.start, e.end) });
    }
  }
  // back to front, so the offsets of the edits still to come stay valid
  let out = text;
  for (const { apply } of edits.sort((a, b) => b.at - a.at)) out = apply(out);
  const before = folderSet(out);
  out = registerPaths(out, result.added, newFolders);
  result.addedFolders = listEntries(out).filter(e => e.kind === 'Folder' && !before.has(lower(e.rel))).map(e => e.rel);
  result.text = out;
  return result;
}

/** One-line-per-change summary of a repair. */
export function describeResolve(r: ResolveResult): string[] {
  const lines: string[] = [];
  for (const x of r.removed) lines.push(`Remove ${x.reason === 'duplicate' ? 'duplicate ' : ''}${x.kind} ${win(x.rel)}${x.reason === 'missing' ? ' (not found)' : ''}`);
  for (const x of r.changed) lines.push(`${x.reason === 'moved' ? 'Move' : 'Fix case of'} ${win(x.from)} → ${win(x.to)}`);
  for (const f of r.addedFolders) lines.push(`Add Folder ${win(f)}`);
  for (const f of r.added) lines.push(`Add Compile ${win(f)}`);
  return lines;
}

/** The smallest single replacement that turns `before` into `after`. */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return { start: p, end: before.length - s, text: after.slice(p, after.length - s) };
}

/**
 * Files and folders below a PLC project folder. Skips TwinCAT output (`_*`) and hidden folders like `findFiles`,
 * and folders of other PLC projects nested inside.
 */
export async function scanProjectDir(dir: string): Promise<DiskTree> {
  const files: string[] = [], folders: string[] = [];
  const visit = async (abs: string, rel: string) => {
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    if (rel && entries.some(e => e.isFile() && /\.plcproj$/i.test(e.name))) return;
    if (rel) folders.push(rel);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skippedDir(e.name)) await visit(path.join(abs, e.name), r); }
      else files.push(r);
    }
  };
  await visit(dir, '');
  return { files: files.sort(), folders: folders.sort() };
}
