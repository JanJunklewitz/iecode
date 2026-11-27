// Lines for the "IECode" output channel (a log channel: error / warning / info) from what the iecode CLI reports:
// its progress lines on stderr (● step, ✔ done, ⚠ warning, ✖ error) and the compiler messages of its JSON result.

import { CliDiagnostic } from './diagnostics';

export type LogLevel = 'error' | 'warning' | 'info';

/** Level and text of a progress line; the marker becomes the level. */
export function progressLine(line: string): { level: LogLevel; text: string } {
  const m = /^\s*([●✔✖⚠])\s*/.exec(line);
  const level: LogLevel = m?.[1] === '✖' ? 'error' : m?.[1] === '⚠' ? 'warning' : 'info';
  return { level, text: m ? line.slice(m[0].length) : line.trim() };
}

/** "C0032 FB_Motor.TcPOU(12,5): Type 'X' not found [PLC1]", as the CLI prints it without --json. */
export function diagnosticLine(d: CliDiagnostic): string {
  const where = d.file ? `${d.file.replace(/^.*[\\/]/, '')}${d.line ? `(${d.line}${d.column ? `,${d.column}` : ''})` : ''}: ` : '';
  return `${d.code ? d.code + ' ' : ''}${where}${d.message}${d.project ? ` [${d.project}]` : ''}`;
}

/** "2 errors, 1 warning, 3 messages" (only the kinds that occur), or '' without diagnostics. */
export function countLine(ds: CliDiagnostic[]): string {
  const n = (s: CliDiagnostic['severity']) => ds.filter(d => d.severity === s).length;
  const part = (k: number, word: string) => (k ? `${k} ${word}${k === 1 ? '' : 's'}` : '');
  return [part(n('error'), 'error'), part(n('warning'), 'warning'), part(n('info'), 'message')].filter(Boolean).join(', ');
}

/** The diagnostics with the CLI's root causes first; the rest keeps its order. */
export function rootCausesFirst(ds: CliDiagnostic[]): CliDiagnostic[] {
  return [...ds.filter(d => d.rootCause), ...ds.filter(d => !d.rootCause)];
}

/**
 * Message for a failed build or check: the first root cause, the static-analysis-only case (builds only: every
 * platform that failed failed on static analysis, so one platform's SA0027 does not label another's C0077), or the
 * error count.
 */
export function buildFailureText(unit: string, ds: CliDiagnostic[], data: { builds?: { ok?: boolean; staticAnalysisOnly?: boolean }[] } | undefined, what: 'build' | 'check' = 'build'): string {
  const errors = ds.filter(d => d.severity === 'error');
  // TwinCAT 4024 reports a library that is not installed as a warning; the CLI marks it as the root cause
  const root = ds.find(d => d.rootCause);
  if (root) {
    const others = errors.filter(d => d !== root).length;
    return `${unit} ${what} failed: ${root.message}${others ? ` (and ${others}${root.severity === 'error' ? ' more' : ''} error(s))` : ''}`;
  }
  const failed = data?.builds?.filter(b => b.ok !== true) ?? [];
  if (failed.length > 0 && failed.every(b => b.staticAnalysisOnly)) return `${unit} build failed only on static analysis (${errors.length} finding(s)).`;
  return `${unit} ${what} failed with ${errors.length} error(s).`;
}

/** True when a failed run has something to show in Problems: a compiler error or a root cause (the generic last line does not count). */
export function hasActionableDiagnostics(ds: CliDiagnostic[]): boolean {
  return compilerErrors(ds) > 0 || ds.some(d => d.rootCause);
}

/** Compiler errors in a result; the CLI reports the generic last line of a failed build as info, so it does not count. */
export function compilerErrors(ds: CliDiagnostic[]): number {
  return ds.filter(d => d.severity === 'error').length;
}

/**
 * False when the CLI stopped before it built anything (no result data and no diagnostics, e.g. exit 2 or 15): the old
 * problems stay. A run that broke off mid-build (timeout) has diagnostics and replaces them.
 */
export function ranBuild(res: { data?: unknown; diagnostics?: CliDiagnostic[] }): boolean {
  return (res.data !== undefined && res.data !== null) || (res.diagnostics?.length ?? 0) > 0;
}

/**
 * A pointer to the version setting: always for exit 15 (version not installed), for a usage error (exit 2) only when
 * its message is about the TwinCAT version; none when the CLI's own hint already names the setting.
 */
export function tcVersionHint(exitCode: number, error?: string, cliHint?: string): string | undefined {
  if (cliHint?.includes('iecode.tcVersion')) return undefined;
  const aboutVersion = exitCode === 15 || (exitCode === 2 && /--tc\b|TwinCAT (version|40\d\d)/i.test(error ?? ''));
  return aboutVersion ? 'Check the TwinCAT version (setting iecode.tcVersion, command "IECode: Select TwinCAT Version…").' : undefined;
}
