// IO links of a TwinCAT project on disk or at a git commit: the .tsproj plus the .xti files it references.

import { promises as fs } from 'fs';
import * as path from 'path';
import { IoSnapshot, readProject } from './iotree';
import { IoLink, sortLinks, toIoLink } from './iolinks';
import { filesAt, repoRoot, showMany } from './git';

/** Links and box catalog of a .tsproj; `ref` undefined = working copy. */
export async function projectAt(tsproj: string, ref: string | undefined): Promise<IoSnapshot> {
  if (!ref) return readProject(tsproj, f => fs.readFile(f, 'utf8').catch(() => undefined));
  const root = await repoRoot(tsproj);
  if (!root) throw new Error(`${tsproj} is not in a git repository`);
  // one git call for every candidate file below the project; TwinCAT's file names may differ in case
  const dir = path.dirname(path.resolve(tsproj));
  const files = await filesAt(root, ref, dir, ['.tsproj', '.xti']);
  // exact name first, as in the CLI (a case-only duplicate in the tree, e.g. committed on Linux)
  const exact = new Map([...(await showMany(root, ref, files))].map(([f, text]) => [path.resolve(f), text]));
  const anyCase = new Map([...exact].map(([f, text]) => [f.toLowerCase(), text]));
  return readProject(tsproj, async f => exact.get(path.resolve(f)) ?? anyCase.get(path.resolve(f).toLowerCase()));
}

/** Links of a .tsproj; `ref` undefined = working copy. Files are reported relative to the project folder. */
export async function linksAt(tsproj: string, ref: string | undefined): Promise<IoLink[]> {
  return sortLinks((await projectAt(tsproj, ref)).links.map(toIoLink));
}
