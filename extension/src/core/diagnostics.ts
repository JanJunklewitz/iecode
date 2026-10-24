// Maps compiler messages from `iecode build --json` (TwinCAT error list) to lines of the plain-ST view.
//
// TwinCAT reports a line relative to one object (the POU itself or one of its methods / properties /
// actions) and names the object in the message or the file, e.g. "FB_Motor.Start". The view shows all
// objects of a file in sections, so the line is shifted to the right section's implementation block.

import { HEADER_RE, IMPL_RE } from '../model';

export interface CliDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  file?: string;
  project?: string;
  line?: number;
  column?: number;
}

export interface ViewPosition { line: number; column: number; section: string }

/** Member named in a message, e.g. "FB_Motor.Start" or "(FB_Motor.Speed.Get)" → { member: 'Start' | 'Speed', accessor }. */
export function memberOf(message: string, objectName: string): { member?: string; accessor?: 'GET' | 'SET' } {
  const re = new RegExp(`\\b${objectName}\\.(\\w+)(?:\\.(Get|Set))?\\b`, 'i');
  const m = re.exec(message);
  if (!m) return {};
  return { member: m[1], accessor: m[2] ? (m[2].toUpperCase() as 'GET' | 'SET') : undefined };
}

/**
 * Position in the view for a diagnostic. Lines are 1-based in TwinCAT and counted from the start of the
 * object's implementation; the result is 0-based. Falls back to the section header when the line is unknown.
 */
export function mapToView(view: string, objectName: string, d: CliDiagnostic): ViewPosition {
  const lines = view.split('\n');
  const { member, accessor } = memberOf(`${d.message} ${d.file ?? ''}`, objectName);
  let header = -1;
  let section = 'MAIN';
  if (member) {
    const want = accessor ?? undefined;
    header = lines.findIndex(l => {
      const m = HEADER_RE.exec(l);
      if (!m || m[2].toLowerCase() !== member.toLowerCase()) return false;
      return want ? m[1] === want : m[1] !== 'GET' && m[1] !== 'SET';
    });
    if (header >= 0) section = `${lines[header].replace(/^\/\/==== | ====\s*$/g, '')}`;
  }
  const end = (() => { for (let i = header + 1; i < lines.length; i++) if (HEADER_RE.test(lines[i])) return i; return lines.length; })();
  const impl = (() => { for (let i = header + 1; i < end; i++) if (IMPL_RE.test(lines[i])) return i; return -1; })();
  const col = Math.max(0, (d.column ?? 1) - 1);
  if (!d.line || d.line < 1) return { line: Math.max(header, 0), column: 0, section };
  const base = impl >= 0 ? impl + 1 : header + 1;
  return { line: Math.min(base + d.line - 1, Math.max(end - 1, 0)), column: col, section };
}
