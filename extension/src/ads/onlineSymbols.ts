// Runs `iecode ads symbols --online` as a short-lived process of its own: the full upload of the symbol table of a running PLC
// is slow and must not run in the watch host, where it would stall samples, waits and confirmed writes.

import { execFile } from 'child_process';
import { OnlineResult, onlineArgs, parseOnlineOutput } from '../core/onlineSymbols';
import type { Parsed } from '../core/toolInput';
import { customCliPath, useInstallDir } from '../cli/iecode';

const TIMEOUT_MS = 60_000;

export function listOnline(target: string, port: number, filter: string, signal?: AbortSignal): Promise<Parsed<OnlineResult>> {
  useInstallDir();
  return new Promise(resolve => {
    const child = execFile(customCliPath() ?? 'iecode', onlineArgs(target, port, filter),
      { env: { ...process.env, NO_COLOR: '1' }, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal },
      (err, stdout) => {
        // the CLI prints its error as a JSON result document too, so a failing exit code still has a readable reason
        const parsed = parseOnlineOutput(String(stdout ?? ''));
        if (parsed.ok || !err) return resolve(parsed);
        const killed = (err as { killed?: boolean }).killed;
        resolve(killed ? { ok: false, error: `no answer within ${TIMEOUT_MS / 1000} s` } : parsed.ok === false && parsed.error.startsWith('The iecode CLI returned no result') ? { ok: false, error: err.message } : parsed);
      });
    child.stdin?.end();
  });
}
