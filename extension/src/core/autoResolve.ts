// Semantic auto-resolve of a conflicted TwinCAT object file: merge the ST views of git's index stages
// and encode the result into ours' XML, so conflict markers are left only inside code (CDATA).

import * as path from 'path';
import { promises as fs } from 'fs';
import { repoRoot, stage, mergeText, mergeLabels } from './git';
import { isEncrypted } from './projects';
import { decode, encode, nonStBodies, ViewError, HEADER_RE, IMPL_RE } from '../model';

/** Auto-resolve can't (or mustn't) handle this file; the message is meant for the user. */
export class AutoResolveError extends Error {}

/** Index stages of an unmerged file (raw blobs); `base` is missing when both sides added the file. */
export interface Stages { base?: string; ours: string; theirs: string }

/** What a resolution was computed from: the three stages and the working file (undefined = missing). */
export interface Snapshot { base?: string; ours?: string; theirs?: string; working?: string }

const BOM = '﻿';
const stripBom = (s: string) => (s.startsWith(BOM) ? s.slice(1) : s);
const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** Reads the stages and the working file now, for computing a resolution or re-checking one before writing. */
export const snapshotOf = async (file: string) => snapshotIn(await rootOf(file), file);

async function rootOf(file: string): Promise<string> {
  const root = await repoRoot(file);
  if (!root) throw new AutoResolveError(`${path.basename(file)}: not in a git repository`);
  return root;
}

async function snapshotIn(root: string, file: string): Promise<Snapshot> {
  const [base, ours, theirs, working] = await Promise.all([
    stage(root, 1, file), stage(root, 2, file), stage(root, 3, file),
    fs.readFile(file, 'utf8').catch(() => undefined),
  ]);
  return { base, ours, theirs, working };
}

/** True when nothing changed between two snapshots (git index and working file). */
export const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.base === b.base && a.ours === b.ours && a.theirs === b.theirs && a.working === b.working;

/** Merges the ST views of the stages into ours' XML; does not write. Throws AutoResolveError when it can't. */
export async function autoResolve(file: string): Promise<{ xml: string; codeConflicts: number; snapshot: Snapshot & Stages }> {
  const name = path.basename(file);
  const refuse = (why: string) => new AutoResolveError(`${name}: ${why}`);
  const root = await rootOf(file);
  const snap = await snapshotIn(root, file);
  const { ours, theirs } = snap;
  // no stage 2 and 3 at all: not unmerged (or git failed), which is not a delete/modify conflict
  if (ours === undefined && theirs === undefined) throw refuse('no merge conflict in the git index');
  if (ours === undefined || theirs === undefined) throw refuse('deleted on one side; resolve in Source Control');
  const snapshot = { ...snap, ours, theirs };

  const [oursXml, baseXml, theirsXml] = [ours, snap.base ?? '', theirs].map(stripBom);
  if ([oursXml, baseXml, theirsXml].some(isEncrypted)) throw refuse('encrypted; resolve in TwinCAT');
  const view = (xml: string) => {
    try { return xml ? decode(xml) : ''; } catch (e) { throw refuse((e as Error).message); }
  };
  const merged = await mergeText(view(oursXml), view(baseXml), view(theirsXml), { ...await mergeLabels(root), base: 'base' });

  // a hunk holding a section header or IMPLEMENTATION line would split its markers across sections
  if (hunkLines(merged.text).some(l => HEADER_RE.test(l) || IMPL_RE.test(l)))
    throw refuse('conflict in the object structure; use the XML merge editor');

  // BOM and EOL come from the working file: the stages are LF when git normalises line ends
  const working = snap.working ?? ours;
  const eol = working.includes('\r\n') ? '\r\n' : '\n';
  let xml: string;
  try {
    xml = encode(lf(oursXml).replace(/\n/g, eol), merged.text);
  } catch (e) {
    if (e instanceof ViewError) throw refuse('conflict in the object structure; use the XML merge editor');
    throw e;
  }

  // the view only shows a placeholder for graphical bodies, so a change to one would be lost silently
  const [o, b, t, res] = [oursXml, baseXml, theirsXml, xml].map(x => (x ? nonStBodies(x) : new Map<string, string>()));
  for (const key of new Set([...o.keys(), ...t.keys(), ...b.keys()])) {
    const lost = (side: Map<string, string>) => side.get(key) !== b.get(key) && side.get(key) !== res.get(key);
    if (lost(o) || lost(t)) throw refuse('graphical implementation changed on both sides; use the XML merge editor');
  }

  return { xml: (working.startsWith(BOM) ? BOM : '') + xml, codeConflicts: merged.conflicts, snapshot };
}

/** Lines between conflict markers (all sides). */
function hunkLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of text.split('\n')) {
    if (/^<{7}(?: |$)/.test(l)) inside = true;
    else if (/^>{7}(?: |$)/.test(l)) inside = false;
    else if (inside) out.push(l);
  }
  return out;
}

/** The text without BOM, CR, marker labels and diff3 base sections: what is left of a conflict whatever the style. */
function comparable(text: string): string {
  const out: string[] = [];
  let inBase = false;
  for (const l of lf(stripBom(text)).split('\n')) {
    if (/^\|{7}(?: |$)/.test(l)) { inBase = true; continue; }
    if (/^={7}$/.test(l)) inBase = false;
    else if (inBase) continue;
    const m = /^(<{7}|>{7})(?: |$)/.exec(l);
    out.push(m ? m[1] : l);
  }
  return out.join('\n');
}

/**
 * True when the working file differs from a conflict re-created from the raw XML stages, i.e. the user may have
 * edited it by hand. Conservative: git's own merge can differ (labels are ignored, other merge drivers are not).
 */
export async function editedSinceConflict(file: string, stages: Stages, labels: { ours: string; theirs: string },
  workingText?: string): Promise<boolean> {
  const working = workingText ?? await fs.readFile(file, 'utf8').catch(() => undefined);
  if (working === undefined) return true;
  const strip = (s: string) => lf(stripBom(s));
  const recreated = await mergeText(strip(stages.ours), strip(stages.base ?? ''), strip(stages.theirs), { ...labels, base: 'base' });
  return comparable(recreated.text) !== comparable(working);
}
