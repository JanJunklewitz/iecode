// The iecode.* settings as form fields, derived from the "configuration" block of package.json so a new setting
// shows up in the settings panel without a second list. Pure: no vscode import.

import { checkLogDirectory } from './logRead';

export type ConfigGroup = 'General' | 'IO-Link' | 'ADS Watch';
export type ConfigType = 'boolean' | 'string' | 'enum' | 'integer' | 'list' | 'object';

export interface ConfigField {
  key: string;                    // full key, e.g. iecode.ads.port
  label: string;                  // key without the iecode. prefix
  group: ConfigGroup;
  type: ConfigType;
  description: string;
  def: unknown;
  enum?: string[];
  enumDescriptions?: string[];
  min?: number;
  max?: number;
  userOnly: boolean;              // scope "application" or "machine": a workspace value is ignored
}

/** Settings that have their own editor. */
const SKIP = new Set(['iecode.configDiff.hidden']);
export const GROUPS: ConfigGroup[] = ['General', 'IO-Link', 'ADS Watch'];

const plain = (s: unknown): string => String(s ?? '').replace(/\*\*|`/g, '');

export function groupOf(key: string): ConfigGroup {
  if (key.startsWith('iecode.ads.')) return 'ADS Watch';
  if (/^iecode\.io-?link\./i.test(key)) return 'IO-Link';
  return 'General';
}

function typeOf(p: Record<string, unknown>): ConfigType | undefined {
  if (Array.isArray(p.enum)) return 'enum';
  if (p.type === 'boolean' || p.type === 'string' || p.type === 'integer') return p.type;
  if (p.type === 'array') return 'list';
  if (p.type === 'object') return 'object';
  return undefined;
}

export function configFields(properties: Record<string, Record<string, unknown>>): ConfigField[] {
  const out: ConfigField[] = [];
  for (const [key, p] of Object.entries(properties)) {
    const type = typeOf(p);
    if (!type || SKIP.has(key) || !key.startsWith('iecode.')) continue;
    out.push({
      key, label: key.slice('iecode.'.length), group: groupOf(key), type,
      description: plain(p.markdownDescription ?? p.description), def: p.default,
      enum: Array.isArray(p.enum) ? p.enum.map(String) : undefined,
      enumDescriptions: Array.isArray(p.enumDescriptions) ? p.enumDescriptions.map(plain) : undefined,
      min: typeof p.minimum === 'number' ? p.minimum : undefined,
      max: typeof p.maximum === 'number' ? p.maximum : undefined,
      userOnly: p.scope === 'application' || p.scope === 'machine',
    });
  }
  return out;
}

/** The form text of a setting value: one entry per line for a list, JSON for an object. */
export function toInputText(f: ConfigField, v: unknown): string {
  if (f.type === 'list') return Array.isArray(v) ? v.join('\n') : '';
  if (f.type === 'object') return JSON.stringify(v ?? {}, null, 2);
  return v === undefined || v === null ? '' : String(v);
}

/**
 * The setting value for what the form sent (boolean for a checkbox, text otherwise), or the reason it is not valid.
 */
export function parseInput(f: ConfigField, raw: unknown): { value: unknown } | { problem: string } {
  const bad = (m: string) => ({ problem: `${f.label}: ${m}` });
  switch (f.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : bad('must be on or off.');
    case 'enum':
      return typeof raw === 'string' && f.enum?.includes(raw) ? { value: raw } : bad(`must be one of ${f.enum?.join(', ')}.`);
    case 'integer': {
      const t = typeof raw === 'string' ? raw.trim() : '';
      if (!/^-?\d{1,15}$/.test(t)) return bad('must be a whole number.');
      const n = Number(t);
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return bad(`must be from ${f.min ?? '-∞'} to ${f.max ?? '∞'}.`);
      return { value: n };
    }
    case 'string': {
      const t = typeof raw === 'string' ? raw.trim() : '';
      if (f.key === 'iecode.ads.logDirectory' && t) {
        const c = checkLogDirectory(t);
        if ('problem' in c) return { problem: c.problem };
      }
      return { value: t };
    }
    case 'list':
      return typeof raw === 'string'
        ? { value: raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean) } : bad('must be text, one entry per line.');
    case 'object': {
      let o: unknown;
      try { o = JSON.parse(typeof raw === 'string' && raw.trim() ? raw : '{}'); } catch { return bad('is not valid JSON.'); }
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return bad('must be a JSON object.');
      for (const [k, v] of Object.entries(o)) {
        if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return bad(`"${k}" must be a list of strings.`);
      }
      return { value: o };
    }
  }
}
