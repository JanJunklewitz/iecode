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
