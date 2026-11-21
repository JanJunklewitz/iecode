// Which symbols an AI tool may write: the user's list of path prefixes (iecode.ads.aiWritePaths). Pure: no imports.
// The list limits symbol names, not machines: it says nothing about which PLC a name is written on.

export interface WritePolicySettings { allowedPaths: string[] }

const norm = (s: string): string => s.trim().toLowerCase();

/** A prefix matches the symbol itself and everything below it (`.` or `[` follows), not a longer name. */
function matches(symbol: string, prefix: string): boolean {
  if (prefix.endsWith('.')) return symbol.startsWith(prefix);
  if (!symbol.startsWith(prefix)) return false;
  const next = symbol[prefix.length];
  return next === undefined || next === '.' || next === '[';
}

function listText(s: WritePolicySettings): string {
  return s.allowedPaths.map(p => p.trim()).filter(Boolean).join(', ');
}

/**
 * Empty list = no restriction. Blank entries are ignored; a non-empty list with only blank entries allows nothing
 * (the safe reading of a half-edited setting).
 */
function isAllowed(symbol: string, s: WritePolicySettings): boolean {
  if (s.allowedPaths.length === 0) return true;
  const sym = norm(symbol);
  return s.allowedPaths.map(norm).filter(Boolean).some(p => matches(sym, p));
}

const outside = (names: string[], s: WritePolicySettings): string =>
  `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: ${listText(s)})`;

export function evaluateWritePolicy(symbol: string, s: WritePolicySettings): { allowed: boolean; reason?: string } {
  return isAllowed(symbol, s) ? { allowed: true } : { allowed: false, reason: outside([symbol.trim()], s) };
}

/** One reason for a whole op naming every symbol outside the allowed paths; undefined when all are allowed. */
export function writePolicyReason(symbols: readonly string[], s: WritePolicySettings): string | undefined {
  const bad = symbols.filter(x => !isAllowed(x, s)).map(x => x.trim());
  return bad.length ? outside(bad, s) : undefined;
}

/**
 * The symbols of `symbols` that lie below one of the user's prefixes of persistent or configuration data
 * (iecode.ads.persistentPaths; same matching as the allow-list) or are marked persistent in the build output (`built`: lower-case
 * names of the symbols the .tmc marks, parents count for their members). Blank entries are ignored; no list and no mark guard nothing.
 */
export function persistentIn(symbols: readonly string[], persistentPaths: readonly string[], built: ReadonlySet<string> = new Set()): string[] {
  const prefixes = persistentPaths.map(norm).filter(Boolean);
  return symbols.filter(s => {
    const n = norm(s);
    return prefixes.some(p => matches(n, p)) || underBuilt(n, built);
  }).map(s => s.trim());
}

/** True when the symbol or one of its parents (`a.b.c` has `a.b` and `a`; `a[2].b` has `a[2]` and `a`) is marked persistent in the build output. */
const LAST_STEP = /(\.[^.[]*|\[[^\]]*\])$/;
function underBuilt(name: string, built: ReadonlySet<string>): boolean {
  if (!built.size) return false;
  for (let n = name; n; n = n.replace(LAST_STEP, '')) {
    if (built.has(n)) return true;
    if (!LAST_STEP.test(n)) break;
  }
  return false;
}

/** The refusal of a write to persistent data that the user did not ask for. */
export function persistentRefusal(persistent: readonly string[]): string {
  return persistent.length === 1
    ? `${persistent[0]} is PERSISTENT data (it survives a PLC restart). Call again with confirmPersistent: true if the user asked for this write.`
    : `${persistent.join(', ')} are PERSISTENT data (they survive a PLC restart). Call again with confirmPersistent: true if the user asked for these writes.`;
}
