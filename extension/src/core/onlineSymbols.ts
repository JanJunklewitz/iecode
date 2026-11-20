// The online symbol list of the iecode CLI (`iecode ads symbols --online`): its arguments and its result document. Pure.

import type { Parsed } from './toolInput';

export interface OnlineResult { target: string; total: number; symbols: { name: string; type: string; comment?: string | null }[] }

export function onlineArgs(target: string, port: number, filter: string): string[] {
  return ['ads', 'symbols', '--online', '--target', target, '--port', String(port), '--filter', filter, '--json'];
}

const NO_RESULT = 'The iecode CLI returned no result for the online symbol list.';

/** The result document is the last non-empty line of the output; progress text may come before it. */
export function parseOnlineOutput(stdout: string): Parsed<OnlineResult> {
  const last = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
  if (!last) return { ok: false, error: NO_RESULT };
  let doc: { ok?: unknown; error?: unknown; data?: { target?: unknown; total?: unknown; symbols?: unknown } };
  try {
    doc = JSON.parse(last);
  } catch {
    return { ok: false, error: NO_RESULT };
  }
  if (doc.ok === false) return { ok: false, error: typeof doc.error === 'string' && doc.error ? doc.error : NO_RESULT };
  const d = doc.data;
  if (doc.ok !== true || !d || typeof d.target !== 'string' || typeof d.total !== 'number' || !Array.isArray(d.symbols)) return { ok: false, error: NO_RESULT };
  return { ok: true, value: { target: d.target, total: d.total, symbols: d.symbols as OnlineResult['symbols'] } };
}

export const onlineFailureText = (reason: string): string => `Online symbol list failed: ${reason}. Showing the source code instead.`;
