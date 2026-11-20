// Where `ads_symbols` takes its list from, per PLC project: the build output when there is one, else the running PLC (a filter
// is needed, the table is huge), else the source code. Pure: what exists and what the CLI can do comes in.

export type SourceChoice = 'auto' | 'online' | 'build' | 'source';

export interface UnitState { name: string; hasBuild: boolean; isLibrary: boolean }

export interface SourcePlan {
  /** The running PLC is asked once for every unit without a build output. */
  online: boolean;
  perUnit: { unit: string; source: 'build' | 'source' | 'skip' }[];
  error?: string;
  notes: string[];
}

const NEEDS_FILTER = 'The online symbol list needs a filter or prefix; showing the source code instead.';
const NEEDS_CLI = 'The online symbol list needs a newer iecode CLI: onlineSymbols; showing the source code instead.';

export function planSources(o: { choice: SourceChoice; units: UnitState[]; onlineSupported: boolean; hasFilter: boolean }): SourcePlan {
  const { choice, units } = o;
  if (choice === 'source') return { online: false, perUnit: units.map(u => ({ unit: u.name, source: 'source' as const })), notes: [] };
  if (choice === 'build') return { online: false, perUnit: units.map(u => ({ unit: u.name, source: u.hasBuild ? 'build' as const : 'skip' as const })), notes: [] };
  if (choice === 'online') {
    if (!o.hasFilter) return { online: false, perUnit: [], notes: [], error: 'source "online" needs a filter or prefix: a running PLC has too many symbols to list.' };
    if (!o.onlineSupported) return { online: false, perUnit: [], notes: [], error: 'source "online" needs a newer iecode CLI: onlineSymbols.' };
    return { online: true, perUnit: [], notes: [] };
  }
  // auto: a unit with a build output is answered from it; the others fall back, library projects silently
  const perUnit: SourcePlan['perUnit'] = [];
  const notes: string[] = [];
  let online = false;
  for (const u of units) {
    if (u.hasBuild) perUnit.push({ unit: u.name, source: 'build' });
    else if (u.isLibrary) perUnit.push({ unit: u.name, source: 'skip' });
    else if (o.onlineSupported && o.hasFilter) online = true;
    else {
      perUnit.push({ unit: u.name, source: 'source' });
      const note = o.onlineSupported ? NEEDS_FILTER : NEEDS_CLI;
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return { online, perUnit, notes };
}
