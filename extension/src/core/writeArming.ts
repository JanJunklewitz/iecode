/** Time window of auto-approved AI writes: `auto` only counts while it is armed and the window has not ended. */

export const AUTO_MINUTES_DEFAULT = 60;
const MINUTE_MS = 60_000;

/** Integer 1..1440, anything else falls back to the default. */
export function clampAutoMinutes(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 1440 ? raw : AUTO_MINUTES_DEFAULT;
}

export type AutoState =
  | { kind: 'notAuto' }
  | { kind: 'armed'; untilMs: number; leftMs: number }
  | { kind: 'notArmed' }
  | { kind: 'expired'; untilMs: number };

export function autoState(o: { setting: string; armedAt: unknown; minutes: number; nowMs: number }): AutoState {
  if (o.setting !== 'auto') return { kind: 'notAuto' };
  const armedMs = typeof o.armedAt === 'string' ? Date.parse(o.armedAt) : NaN;
  if (Number.isNaN(armedMs) || armedMs > o.nowMs) return { kind: 'notArmed' };
  const untilMs = armedMs + o.minutes * MINUTE_MS;
  if (untilMs <= o.nowMs) return { kind: 'expired', untilMs };
  return { kind: 'armed', untilMs, leftMs: untilMs - o.nowMs };
}

/** The setting the write decision uses: 'auto' turns into 'confirm' unless armed. */
export function effectiveSetting(setting: string, s: AutoState): string {
  return setting === 'auto' && s.kind !== 'armed' ? 'confirm' : setting;
}

export const REDIRECT_NOTE = ' (the workspace settings set the ADS target or port, so auto-approve does not apply)';

/** Note appended to the confirmation text; the redirect note wins when the workspace redirects the target. */
export function autoNote(s: AutoState, redirected: boolean): string {
  if (redirected) return REDIRECT_NOTE;
  if (s.kind === 'expired') return ' (auto-approve expired; re-arm it with "IECode: Set AI Write Access…")';
  if (s.kind === 'notArmed') return ' (auto-approve is not armed; arm it with "IECode: Set AI Write Access…")';
  return '';
}

/** ADS Watch view description part, undefined for notAuto. */
export function autoLabel(s: AutoState): string | undefined {
  switch (s.kind) {
    case 'armed': return `AI writes: auto (${Math.ceil(s.leftMs / MINUTE_MS)} min left)`;
    case 'expired': return 'AI writes: auto expired, confirming';
    case 'notArmed': return 'AI writes: auto not armed, confirming';
    default: return undefined;
  }
}

export function armedAtNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** Delay of the next view refresh while armed: the next whole-minute change of the label or the expiry, whichever is first. */
export function nextRefreshMs(s: AutoState): number | undefined {
  return s.kind === 'armed' ? s.leftMs % MINUTE_MS || MINUTE_MS : undefined;
}
