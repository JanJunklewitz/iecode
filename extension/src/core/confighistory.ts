// Config entries of an .xti file in the working copy or at a git commit, and the plain-text report of a diff.

import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigEntry, flattenConfig } from './configmodel';
import { ConfigChange, Filter, groupChanges } from './configdiff';
import { isCommit, repoRoot, show } from './git';

export interface ConfigVersion { entries: ConfigEntry[]; missing: boolean }

/** `ref` undefined = working copy. A file that does not exist there is reported as missing (no entries), not as an error. */
export async function configAt(file: string, ref: string | undefined): Promise<ConfigVersion> {
  let xml: string | undefined;
  if (!ref) xml = await fs.readFile(file, 'utf8').catch(() => undefined);
  else {
    const root = await repoRoot(file);
    if (!root) throw new Error(`${file} is not in a git repository`);
    // show() turns every failure into undefined: tell a bad ref from a missing file first
    if (!(await isCommit(root, ref))) throw new Error(`${ref}: not a commit`);
    xml = await show(root, ref, path.resolve(file));
  }
  return xml === undefined ? { entries: [], missing: true } : { entries: flattenConfig(xml.replace(/^﻿/, '')), missing: false };
}

export function changesToText(changes: ConfigChange[], hidden: ReadonlySet<Filter>): string {
  const { groups, links } = groupChanges(changes, hidden, Infinity);
  const visible = groups.reduce((n, g) => n + g.total, 0);
  const out = [`${visible} visible change(s), ${groups.reduce((n, g) => n + g.hidden, 0)} hidden`];
  for (const g of groups.filter(x => x.total)) {
    out.push(`## ${g.category} (${g.total})`);
    for (const c of g.shown) out.push(`${c.kind.padEnd(7)}  ${c.key}  ${c.before ?? ''}${c.before !== undefined && c.after !== undefined ? ' -> ' : ''}${c.after ?? ''}`.trimEnd());
  }
  if (links) out.push(`${links} IO link change(s): see links-diff`);
  return out.join('\n') + '\n';
}
