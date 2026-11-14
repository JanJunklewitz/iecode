// Keeps a .plcproj in step with files created, deleted, renamed or moved outside the project tree
// (VS Code explorer, paste, drag and drop). Pure text edits on top of plcproj.ts.

import * as path from 'path';
import { NewObjectKind, guid } from './templates';
import { addCompile, addFolder, hasCompile, removeCompile, removeFolder, renamePath } from './plcproj';

/** Object files TwinCAT lists as <Compile Include="…"> in a .plcproj. */
export const TC_OBJECT_EXTS = ['.TcPOU', '.TcDUT', '.TcGVL', '.TcIO', '.TcTTO', '.TcVIS', '.TcGTLO', '.TcTLO', '.TcIPO', '.TcGIPO', '.TcVMO'];
const EXTS_LOWER = new Set(TC_OBJECT_EXTS.map(e => e.toLowerCase()));

export const isTcObjectFile = (file: string) => EXTS_LOWER.has(path.extname(file).toLowerCase());

/**
 * Path of a file or folder relative to a PLC project folder, with '/' separators; undefined when it is outside,
 * is the folder itself, or lies below a TwinCAT output / tool folder (_CompileInfo, _Boot, .vs, …).
 */
export function relInProject(projectDir: string, file: string): string | undefined {
  const rel = path.relative(projectDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(/[\\/]/);
  if (parts.some(p => p.startsWith('_') || p.startsWith('.'))) return undefined;
  return parts.join('/');
}

/** Registers object files and folders; parent folders are added as needed. Idempotent. */
export function registerPaths(text: string, files: string[], folders: string[] = []): string {
  for (const f of folders) text = addFolder(text, f);
  for (const rel of files) {
    const dir = path.posix.dirname(rel);
    if (dir !== '.') text = addFolder(text, dir);
    text = addCompile(text, rel);
  }
  return text;
}

/** Removes the entries of deleted files and folders (a folder: also everything below it). */
export function unregisterPaths(text: string, rels: string[]): string {
  for (const rel of rels) text = hasCompile(text, rel) ? removeCompile(text, rel) : removeFolder(text, rel);
  return text;
}

/** Moves the entry of a renamed / moved file or folder within one project; adds the new parent folders. */
export function movePath(text: string, from: string, to: string): string {
  text = renamePath(text, from, to);
  const dir = path.posix.dirname(to);
  return dir !== '.' ? addFolder(text, dir) : text;
}

/** What an empty new object file can be filled with, by extension. Other kinds can't be created without TwinCAT. */
export const TEMPLATE_KINDS: Record<string, NewObjectKind[]> = {
  '.tcpou': ['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION'],
  '.tcdut': ['STRUCT', 'ENUM', 'UNION', 'ALIAS'],
  '.tcgvl': ['GVL'],
  '.tcio': ['INTERFACE'],
};

export const templateKinds = (file: string) => TEMPLATE_KINDS[path.extname(file).toLowerCase()] ?? [];

/** Name="…" of the object in a .TcPOU / .TcDUT / .TcGVL / .TcIO file. */
export const objectName = (xml: string) => /<(?:POU|DUT|GVL|Itf)\s+Name="([^"]+)"/.exec(xml)?.[1];

/** Gives every Id="{guid}" in an object file a new GUID (a copied file must not share ids with its original). */
export const freshIds = (xml: string) => xml.replace(/\bId="\{[0-9a-fA-F-]{36}\}"/g, () => `Id="${guid()}"`);
