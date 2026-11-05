// Discovery files of the MCP bridge: one instance file per serving window, a user-level "connected" marker and the check
// that the directory is private. Filesystem calls are injected (FsOps) so the logic is tested without %LOCALAPPDATA%.
// `writeInstance`, `removeInstance` and `sweepStaleInstances` take the instances directory (`...\v1\instances`);
// the marker functions take the discovery directory (`...\v1`).

import { InstanceFile } from './mcpWire';

export interface FsOps {
  mkdir(p: string): void;
  write(p: string, text: string): void;
  rename(a: string, b: string): void;
  list(dir: string): string[];
  read(p: string): string;
  remove(p: string): void;
  exists(p: string): boolean;
  mtimeMs(p: string): number;
}

export const CONNECTED_MARKER = 'connected';

const sep = (dir: string): string => (dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + '\\');
const instancePath = (dir: string, id: string): string => `${sep(dir)}${id}.json`;

/** Temp file, then rename, so a reader never sees half a file. Calling it again refreshes the mtime (the owner's heartbeat). */
export function writeInstance(dir: string, file: InstanceFile, fs: FsOps): void {
  fs.mkdir(dir);
  const tmp = `${sep(dir)}${file.id}.tmp`;
  fs.write(tmp, JSON.stringify(file, null, 2) + '\n');
  fs.rename(tmp, instancePath(dir, file.id));
}

export function removeInstance(dir: string, id: string, fs: FsOps): void {
  const p = instancePath(dir, id);
  if (fs.exists(p)) fs.remove(p);
}

/**
 * Deletes a file only when it was not refreshed for `maxAgeMs` AND its pipe cannot be connected. A fresh file is never
 * touched, so a paused or busy window is never erased by another window. Pid and start time are informational only.
 */
export async function sweepStaleInstances(dir: string, fs: FsOps, now: number, maxAgeMs: number, canConnect: (pipe: string) => Promise<boolean>): Promise<void> {
  let names: string[];
  try {
    names = fs.list(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = `${sep(dir)}${name}`;
    try {
      if (now - fs.mtimeMs(path) < maxAgeMs) continue;
      if (name.endsWith('.tmp')) {
        fs.remove(path);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const file = JSON.parse(fs.read(path)) as Partial<InstanceFile>;
      if (typeof file.pipe !== 'string') continue;
      if (!(await canConnect(`\\\\.\\pipe\\${file.pipe}`))) fs.remove(path);
    } catch {
      // unreadable or racing with its owner: leave it alone
    }
  }
}

export function setConnectedMarker(dir: string, on: boolean, fs: FsOps): void {
  const p = `${sep(dir)}${CONNECTED_MARKER}`;
  if (on) {
    fs.mkdir(dir);
    fs.write(p, '1\n');
  } else if (fs.exists(p)) {
    fs.remove(p);
  }
}

export function connectedMarker(dir: string, fs: FsOps): boolean {
  return fs.exists(`${sep(dir)}${CONNECTED_MARKER}`);
}

// Principals of `icacls` output in English and German that mean "other users": Everyone, BUILTIN\Users, Authenticated Users.
const OTHERS: RegExp[] = [
  /(^|\s)(Everyone|Jeder)$/i,
  /(BUILTIN|VORDEFINIERT)\\(Users|Benutzer)$/i,
  /(NT AUTHORITY|NT-AUTORIT.T)\\(Authenticated Users|Authentifizierte Benutzer)$/i,
  /\*?S-1-1-0$/,
  /\*?S-1-5-32-545$/,
  /\*?S-1-5-11$/,
];

/** Parses `icacls <dir>`: true when an other-users principal has a grant. Owner, SYSTEM and Administrators are fine. */
export function aclAllowsOthers(icaclsOutput: string): boolean {
  for (const raw of icaclsOutput.split(/\r?\n/)) {
    const m = /^(.*?):\(([^)]*)\)/.exec(raw.trim());
    if (!m || /\(DENY\)/i.test(raw)) continue;
    const principal = m[1].trim();
    if (OTHERS.some(re => re.test(principal))) return true;
  }
  return false;
}
