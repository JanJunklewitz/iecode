// Library reference edits on .plcproj text (same rules as `iecode lib update`): sets the version of a
// library wherever it is resolved (default resolution, pinned resolution, direct reference) and keeps
// everything else byte-identical.

export interface ReferenceChange { library: string; vendor: string; from: string; to: string }

const RESOLUTION = /([>"]\s*)([^,<>"]+?)(\s*,\s*)([^\s(<>"]+)(\s*\(([^)<>"]+)\))/g;
export const VALID_VERSION = /^(\*|\d+(\.\d+){1,3})$/;

export function setLibraryVersion(text: string, library: string, version: string, vendor?: string): { text: string; changes: ReferenceChange[] } {
  if (!VALID_VERSION.test(version)) throw new Error(`Invalid library version '${version}' (use * or e.g. 1.3.0)`);
  const changes: ReferenceChange[] = [];
  const out = text.replace(RESOLUTION, (all, pre: string, name: string, sep: string, ver: string, post: string, ven: string) => {
    if (name.trim().toLowerCase() !== library.toLowerCase()) return all;
    if (vendor && ven.trim().toLowerCase() !== vendor.toLowerCase()) return all;
    if (ver === version) return all;
    changes.push({ library: name.trim(), vendor: ven.trim(), from: ver, to: version });
    return pre + name + sep + version + post;
  });
  return { text: out, changes };
}

/** Numeric comparison of dotted versions (3.3.10.0 > 3.3.9.0); '*' sorts highest. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '*') return 1;
  if (b === '*') return -1;
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
