// User-defined groups of member names (setting iecode.ads.presets), read below a path in one call. Pure: no imports.
// Nothing here knows a library's naming: the groups are the user's.

export type Presets = Record<string, string[]>;
export const MAX_PRESETS = 20;
export const MAX_PRESET_MEMBERS = 30;

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,39}$/;
const MEMBER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

export function parsePresets(raw: unknown): { presets: Presets; problems: string[] } {
  const presets: Presets = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { presets, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { presets, problems: ['iecode.ads.presets must be an object of name -> list of member names'] };
  }
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME.test(name)) { problems.push(`preset "${name}": the name may use letters, digits, space, _ and - (1-40 characters)`); continue; }
    if (!Array.isArray(value)) { problems.push(`preset "${name}": the value must be a list of member names`); continue; }
    if (++count > MAX_PRESETS) {
      if (count === MAX_PRESETS + 1) problems.push(`more than ${MAX_PRESETS} presets: the rest is ignored`);
      continue;
    }
    const members: string[] = [];
    for (const m of value) {
      if (typeof m !== 'string' || !MEMBER.test(m)) { problems.push(`preset "${name}": member "${String(m)}" is not a member path`); continue; }
      if (members.length >= MAX_PRESET_MEMBERS) {
        if (members.length === MAX_PRESET_MEMBERS) problems.push(`preset "${name}": more than ${MAX_PRESET_MEMBERS} members, the rest is ignored`);
        members.push(m);   // counted so the problem is written once
        continue;
      }
      members.push(m);
    }
    presets[name] = members.slice(0, MAX_PRESET_MEMBERS);
  }
  return { presets, problems };
}

export const presetSymbols = (path: string, members: string[]): string[] => members.map(m => `${path}.${m}`);

export function presetListText(p: { presets: Presets; problems: string[] }): string {
  const names = Object.keys(p.presets);
  const lines = names.length
    ? names.map(n => `${n}: ${p.presets[n].join(', ')}`)
    : ['No presets defined. Add them in the setting iecode.ads.presets, e.g. { "sequencer": ["nStep", "sStepText", "bBusy"] }.'];
  for (const x of p.problems) lines.push(`Problem: ${x}`);
  return lines.join('\n');
}

export function unknownPresetText(name: string, p: Presets): string {
  const defined = Object.keys(p);
  return `Error: no preset "${name}"; ${defined.length ? `defined: ${defined.join(', ')}` : 'none defined'}`;
}

/** One block: a line per member in the order of the setting (the member suffix, not the full path). */
export function presetText(o: { path: string; preset: string; target: string; results: { symbol: string; type: string; value: string | null; error: string | null }[] }): string {
  const prefix = `${o.path}.`;
  const lines = [`Preset "${o.preset}" of ${o.path} on ${o.target}:`];
  const failed: string[] = [];
  for (const r of o.results) {
    const name = r.symbol.startsWith(prefix) ? r.symbol.slice(prefix.length) : r.symbol;
    if (r.error || r.value === null) {
      failed.push(name);
      lines.push(`${name} : error ${r.error ?? 'no value'}`);
    } else {
      const text = /^W?STRING/i.test(r.type) ? `"${r.value}"` : r.value;
      lines.push(`${name} : ${r.type || '?'} = ${text}`);
    }
  }
  if (failed.length) lines.push(`${failed.length} of ${o.results.length} members could not be read: ${failed.join(', ')}`);
  return lines.join('\n');
}
