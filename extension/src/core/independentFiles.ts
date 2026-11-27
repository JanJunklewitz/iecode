// Independent project files of a TwinCAT system project as a whole:
//
// - planSaveAllIndependent moves every inline EtherCAT box of the IO device files into its own .xti, nested
//   boxes included (a coupler's file then holds the references to its terminals' files), the way TwinCAT stores
//   them. Unlike TwinCAT's bulk command it also moves disabled boxes.
// - findUnreferencedFiles lists the .xti files under _Config that nothing references any more (renamed or
//   removed items, old copies), plus the .bak copies TwinCAT leaves next to them.
//
// Both only compute; the caller writes or deletes.

import * as path from 'path';
import { promises as fs } from 'fs';
import { parseXml, XNode, child } from '../xml';
import { FileReader, hasAncestor, linkFileSet, text, walk } from './iotree';
import { canExtractBoxType, extractBox, pruneUnused } from './iolinkmasters';

export interface FileText { file: string; text: string }

export interface SaveAllPlan {
  /** New .xti files, parents before their children. */
  created: FileText[];
  /** Existing files that change (a box replaced by its reference). */
  changed: FileText[];
  /** Created files that replace an existing file nothing referenced. */
  replaced: string[];
  /** Inline boxes left alone, with the reason. */
  skipped: string[];
  warnings: string[];
}

const key = (f: string) => path.resolve(f).toLowerCase();

function rootOf(src: string): XNode | undefined {
  return parseXml(src.replace(/^﻿/, '')).children.find(c => !c.name.startsWith('?'));
}

/** Inline boxes of a file whose nearest box ancestor is the file's own item (or none): the next level to move. */
function topInlineBoxes(root: XNode): XNode[] {
  const out: XNode[] = [];
  for (const n of walk(root)) {
    if (n.name !== 'Box' || n.attrs.File !== undefined || n.parent === root || hasAncestor(n, 'Mappings')) continue;
    let nested = false;
    for (let a = n.parent; a && a !== root; a = a.parent) if (a.name === 'Box' && a.parent !== root) { nested = true; break; }
    if (!nested) out.push(n);
  }
  return out;
}

/**
 * Plans moving every inline box of the IO device files of `tsproj` into its own .xti. Throws if two boxes would
 * get the same file, or a box would overwrite a file that is still referenced.
 */
export async function planSaveAllIndependent(tsproj: string, read: FileReader): Promise<SaveAllPlan> {
  const warnings: string[] = [];
  const files = await linkFileSet(tsproj, read, warnings);
  const referenced = new Set(files.map(f => key(f.path)));
  const texts = new Map<string, FileText>();
  const changedKeys = new Set<string>();
  const created: FileText[] = [], replaced: string[] = [], skipped: string[] = [];
  const projectDir = path.dirname(path.resolve(tsproj));
  const rel = (f: string) => path.relative(projectDir, f);

  const tsprojKey = key(tsproj);
  for (const f of files) {
    if (f.category !== 'IO' || key(f.path) === tsprojKey) continue;
    texts.set(key(f.path), { file: f.path, text: f.doc.src });
  }
  // Devices still inline in the .tsproj stay there: moving a device needs the .tsproj rewritten.
  const project = files.find(f => key(f.path) === tsprojKey)?.doc;
  const io = project?.root && child(project.root, 'Project') && child(child(project.root, 'Project')!, 'Io');
  for (const d of io?.children ?? []) {
    if (d.name === 'Device' && d.attrs.File === undefined) skipped.push(`${text(project!, child(d, 'Name')) || d.attrs.RemoteName || 'Device'}: device stored in the .tsproj (save it as independent file in TwinCAT first)`);
  }

  const queue = [...texts.keys()];
  while (queue.length) {
    const k = queue.shift()!;
    const entry = texts.get(k)!;
    const root = rootOf(entry.text);
    if (!root || root.name !== 'TcSmItem') continue;
    const boxes = topInlineBoxes(root).sort((a, b) => b.start - a.start);
    let src = entry.text;
    for (const box of boxes) {
      const doc = { src: src.replace(/^﻿/, ''), root };
      const name = text(doc, child(box, 'Name')) || `Box ${box.attrs.Id ?? '?'}`;
      if (!canExtractBoxType(box.attrs.BoxType)) { skipped.push(`${name} in ${rel(entry.file)}: BoxType ${box.attrs.BoxType ?? '?'} is not supported`); continue; }
      // Offsets of boxes before this one are unchanged: the boxes are handled from the end of the file.
      const x = extractBox(src, entry.file, box.start, false);
      const xk = key(x.file);
      if (texts.has(xk)) throw new Error(`Two items would be saved as ${rel(x.file)}. Rename one of them first.`);
      if (referenced.has(xk)) throw new Error(`${rel(x.file)} is already referenced by another item. Rename the box first.`);
      if (await read(x.file) !== undefined) replaced.push(x.file);
      const c = { file: x.file, text: x.content };
      created.push(c);
      texts.set(xk, c);
      queue.push(xk);
      src = x.parent;
    }
    if (src !== entry.text) {
      // Once per file, after its boxes moved: pruning shifts the offsets of everything below <DataTypes>.
      entry.text = pruneUnused(src);
      if (!created.includes(entry)) changedKeys.add(k);
    }
  }
  const changed = [...changedKeys].map(k => texts.get(k)!);
  return { created, changed, replaced, skipped, warnings };
}

/** Writes a plan: the new files first, so a failed write leaves every box in its old place. */
export async function writeSaveAllPlan(plan: SaveAllPlan): Promise<void> {
  for (const c of plan.created) {
    await fs.mkdir(path.dirname(c.file), { recursive: true });
    await fs.writeFile(c.file, c.text, 'utf8');
  }
  for (const c of plan.changed) await fs.writeFile(c.file, c.text, 'utf8');
}

async function* filesBelow(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* filesBelow(p);
    else if (e.isFile()) yield p;
  }
}

/**
 * The .xti (and .xti.bak) files under the project's _Config folder that no item references. A file counts as
 * referenced if the reference chain from the .tsproj reaches it, or, to stay on the safe side, if any loaded file
 * names it in a File="…" attribute.
 */
export async function findUnreferencedFiles(tsproj: string, read: FileReader): Promise<string[]> {
  const warnings: string[] = [];
  const files = await linkFileSet(tsproj, read, warnings);
  const reached = new Set(files.map(f => key(f.path)));
  const named = new Set<string>();
  for (const f of files) for (const m of f.doc.src.matchAll(/\sFile="([^"]+)"/g)) named.add(path.basename(m[1].replace(/\\/g, '/')).toLowerCase());
  const out: string[] = [];
  for await (const f of filesBelow(path.join(path.dirname(path.resolve(tsproj)), '_Config'))) {
    const lower = f.toLowerCase();
    if (lower.endsWith('.xti.bak')) { out.push(f); continue; }
    if (!lower.endsWith('.xti') || reached.has(key(f)) || named.has(path.basename(lower))) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
