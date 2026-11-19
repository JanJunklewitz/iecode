// One result type for object checks (structure, OOP rules, IO links, unused objects) and the settings switch that sets their level.

import { createHash } from 'crypto';

export type Level = 'error' | 'warning' | 'info' | 'hint';

export interface Finding {
  rule: string;
  level: Level;
  message: string;
  /** Absolute path of the file the finding is anchored in (an object file, a .tsproj, an .xti …). */
  file: string;
  /** 0-based positions. */
  line: number; col: number; endLine: number; endCol: number;
  /** Which text the positions and fix offsets address: the raw XML (`file:` document) or the decoded ST view (`iecode:` document). */
  space?: 'xml' | 'view';
  /** Hash of the analysed text (`textVersion`); a fix is refused when the document no longer has this hash. */
  version?: string;
  /** Offsets are into the text of `file`. */
  fix?: { title: string; edit: { start: number; end: number; text: string } };
}

/** Short hash of a text, to tell whether a finding still matches the document. */
export const textVersion = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

export interface RuleInfo { id: string; description: string; level: Level | 'off' }

/** Rewrites the level of each finding (override, else default, else its own level) and drops the rules that are off. */
export function applyLevels(findings: Finding[], overrides: Record<string, Level | 'off'>, defaults: Record<string, Level | 'off'>): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const level = overrides[f.rule] ?? defaults[f.rule] ?? f.level;
    if (level !== 'off') out.push(level === f.level ? f : { ...f, level });
  }
  return out;
}

/** 0-based line and column of a character offset; a CRLF counts as one line break. */
export function offsetToPosition(text: string, offset: number): { line: number; col: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return { line, col: at - (text.lastIndexOf('\n', at - 1) + 1) };
}

const LEVEL_NAMES: [Level, string, string][] = [['error', 'error', 'errors'], ['warning', 'warning', 'warnings'], ['info', 'info', 'infos'], ['hint', 'hint', 'hints']];

/** `12 findings: 3 errors, 9 warnings; most frequent: name-mismatch (5)`, or `No findings`. */
export function summaryText(findings: Finding[]): string {
  if (!findings.length) return 'No findings';
  const per = LEVEL_NAMES.map(([l, one, many]) => {
    const n = findings.filter(f => f.level === l).length;
    return n ? `${n} ${n === 1 ? one : many}` : '';
  }).filter(Boolean);
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  const [rule, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}: ${per.join(', ')}; most frequent: ${rule} (${n})`;
}
