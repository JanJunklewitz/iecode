// IO links of a TwinCAT project on disk or at a git commit: the .tsproj plus all .xti files below its folder.

import { promises as fs } from 'fs';
import * as path from 'path';
import { extractLinks, IoLink } from './iolinks';
import { findFiles } from './projects';
import { filesAt, repoRoot, show } from './git';

/** Links of a .tsproj; `ref` undefined = working copy. Files are reported relative to the project folder. */
export async function linksAt(tsproj: string, ref: string | undefined): Promise<IoLink[]> {
  const dir = path.dirname(tsproj);
  const relName = (f: string) => path.relative(dir, f).split(path.sep).join('/');
  const links: IoLink[] = [];
  if (!ref) {
    const files = [tsproj, ...(await findFiles(dir, ['.xti'], 8)).filter(f => f !== tsproj)];
    for (const f of files) links.push(...extractLinks(await fs.readFile(f, 'utf8'), relName(f)));
    return links;
  }
  const root = await repoRoot(tsproj);
  if (!root) throw new Error(`${tsproj} is not in a git repository`);
  const files = (await filesAt(root, ref, dir, ['.tsproj', '.xti'])).filter(f => f === tsproj || f.toLowerCase().endsWith('.xti'));
  for (const f of files) {
    const xml = await show(root, ref, f);
    if (xml) links.push(...extractLinks(xml, relName(f)));
  }
  return links;
}
