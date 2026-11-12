// Where a symbol list comes from and whether it may be outdated. Pure: no imports.

/** A source file saved a moment after the build finished (or a clock that is a little off) is not newer. */
export const STALE_TOLERANCE_MS = 2000;
export const MAX_NEWER_LISTED = 3;

const baseName = (f: string): string => f.replace(/\\/g, '/').split('/').pop() ?? f;

/** Base names of the files newer than the build by more than the tolerance, newest first. */
export function newerSources(builtMs: number, sources: { file: string; mtimeMs: number }[], toleranceMs = STALE_TOLERANCE_MS): string[] {
  return sources
    .filter(s => s.mtimeMs > builtMs + toleranceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(s => baseName(s.file));
}

const two = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:mm:ss' in local time. */
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The source line of a build-output listing, plus a warning when source files are newer than the build. */
export function buildHeader(o: { unit: string; builtAt: Date; newer: string[] }): string[] {
  const lines = [`Symbols from the build output of ${o.unit} (built ${localStamp(o.builtAt)}).`];
  if (o.newer.length) {
    const shown = o.newer.slice(0, MAX_NEWER_LISTED).join(', ');
    const rest = o.newer.length - MAX_NEWER_LISTED;
    const n = o.newer.length;
    lines.push(`Warning: ${n} source file${n === 1 ? ' is' : 's are'} newer than the build output (${shown}${rest > 0 ? ` and ${rest} more` : ''}); the symbols may be outdated. Build the project again.`);
  }
  return lines;
}
