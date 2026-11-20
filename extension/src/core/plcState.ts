// ads_state: the reply of the host op `state`, the comparison with the previous call (restart, online change) and the result
// text. Pure: no VS Code API, the clocks come in, so the wording and the rules are pinned by tests.

import type { ToolNames, ToolText } from './adsToolText';

export interface PlcStateReply {
  adsState?: string;
  deviceState?: number;
  plcError?: string;
  plcAdsCode?: number;
  cycleCount?: number;
  cycleTimeUs?: number;
  onlineChangeCount?: number;
  taskNote?: string;
  systemState?: string;
}

const UNEXPECTED = 'unexpected reply to the state request';
const STRING_FIELDS = ['adsState', 'plcError', 'taskNote', 'systemState'] as const;
const NUMBER_FIELDS = ['deviceState', 'plcAdsCode', 'cycleCount', 'cycleTimeUs', 'onlineChangeCount'] as const;

/** The data of an ok `state` reply; a string is the reason it is not one (the host leaves null fields out). */
export function parsePlcState(data: unknown): PlcStateReply | string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return UNEXPECTED;
  const o = data as Record<string, unknown>;
  const out: PlcStateReply = {};
  for (const f of STRING_FIELDS) {
    if (o[f] === undefined) continue;
    if (typeof o[f] !== 'string') return UNEXPECTED;
    out[f] = o[f] as string;
  }
  for (const f of NUMBER_FIELDS) {
    if (o[f] === undefined) continue;
    if (typeof o[f] !== 'number' || !Number.isFinite(o[f])) return UNEXPECTED;
    out[f] = o[f] as number;
  }
  // the host answers ok only when at least one of the two parts was read
  return out.adsState === undefined && out.systemState === undefined ? UNEXPECTED : out;
}

/** `sinceMs` is the wall-clock time of the call it was compared with. */
export type StateFinding =
  | { kind: 'restart' | 'restartOrWrap' | 'slow'; was: number; now: number; sinceMs: number }
  | { kind: 'cycleTimeChanged'; was: number; now: number; sinceMs: number }
  | { kind: 'onlineChange'; was: number; now: number; sinceMs: number };

const WRAP = 2 ** 32;

/** The *WallMs / *MonoMs overrides mark a family whose values are older than the call itself (its item failed in a later call). */
interface Baseline { state: PlcStateReply; wallMs: number; monoMs: number; cycleWallMs?: number; cycleMonoMs?: number; onlineWallMs?: number }

const hasCounters = (s: PlcStateReply): boolean => s.cycleCount !== undefined || s.onlineChangeCount !== undefined;

/**
 * Compares a call with the previous one of the same key (target and task). One per AdsHost, so a new MCP session keeps the
 * baseline. The counters are evidence, not proof: a restart followed by a long wait counts past the old value and is not seen.
 */
export class StateTracker {
  private readonly baselines = new Map<string, Baseline>();

  /** `wallMs` is for the texts, `monoMs` (a monotonic clock) for the elapsed time. */
  observe(key: string, s: PlcStateReply, wallMs: number, monoMs: number): { first: boolean; findings: StateFinding[] } {
    const prev = this.baselines.get(key);
    // a reply without counters (config mode, PLC unreachable) says nothing: the older baseline stays for the next call;
    // a counter family that is missing in this reply (one item failed) keeps its earlier value and time
    if (hasCounters(s)) {
      const cycle = s.cycleCount !== undefined && s.cycleTimeUs !== undefined;
      const online = s.onlineChangeCount !== undefined;
      const keepCycle = !cycle && prev && prev.state.cycleCount !== undefined;
      const keepOnline = !online && prev && prev.state.onlineChangeCount !== undefined;
      this.baselines.set(key, {
        state: {
          ...s,
          ...(keepCycle ? { cycleCount: prev.state.cycleCount, cycleTimeUs: prev.state.cycleTimeUs } : {}),
          ...(keepOnline ? { onlineChangeCount: prev.state.onlineChangeCount } : {}),
        },
        wallMs, monoMs,
        ...(keepCycle ? { cycleWallMs: prev.cycleWallMs ?? prev.wallMs, cycleMonoMs: prev.cycleMonoMs ?? prev.monoMs } : {}),
        ...(keepOnline ? { onlineWallMs: prev.onlineWallMs ?? prev.wallMs } : {}),
      });
    }
    if (!prev) return { first: true, findings: [] };
    const findings: StateFinding[] = [];
    const cycleSince = prev.cycleWallMs ?? prev.wallMs, onlineSince = prev.onlineWallMs ?? prev.wallMs;
    const cycleMono = prev.cycleMonoMs ?? prev.monoMs;
    const p = prev.state;
    let restarted = false;
    if (p.cycleCount !== undefined && s.cycleCount !== undefined && p.cycleTimeUs !== undefined && s.cycleTimeUs !== undefined && s.cycleTimeUs > 0 && p.cycleTimeUs > 0) {
      if (s.cycleTimeUs !== p.cycleTimeUs) {
        findings.push({ kind: 'cycleTimeChanged', was: p.cycleTimeUs, now: s.cycleTimeUs, sinceMs: cycleSince });
      } else {
        const expected = ((monoMs - cycleMono) * 1000) / s.cycleTimeUs;
        if (s.cycleCount < p.cycleCount) {
          restarted = true;
          findings.push({ kind: p.cycleCount >= WRAP - 1.5 * expected ? 'restartOrWrap' : 'restart', was: p.cycleCount, now: s.cycleCount, sinceMs: cycleSince });
        } else if (expected >= 100 && s.cycleCount - p.cycleCount < expected / 2) {
          findings.push({ kind: 'slow', was: p.cycleCount, now: s.cycleCount, sinceMs: cycleSince });
        }
      }
    }
    if (!restarted && p.onlineChangeCount !== undefined && s.onlineChangeCount !== undefined && s.onlineChangeCount !== p.onlineChangeCount) {
      findings.push({ kind: 'onlineChange', was: p.onlineChangeCount, now: s.onlineChangeCount, sinceMs: onlineSince });
    }
    return { first: false, findings };
  }
}

const ms = (us: number): string => `${(us / 1000).toFixed(3)} ms`;
const CONFIG_NOTE = 'config mode: no PLC program runs';

const systemLine = (s: string, target?: string): string =>
  `TwinCAT system${target ? ` on ${target}` : ''}: ${s}${s === 'Config' ? ` (${CONFIG_NOTE})` : ''}.`;

function findingText(f: StateFinding, clock: (ms: number) => string): string {
  const since = `since the call at ${clock(f.sinceMs)}`;
  switch (f.kind) {
    case 'restart': return `The cycle count went down from ${f.was} to ${f.now} ${since}: the PLC restarted (or a download reset the task).`;
    case 'restartOrWrap': return `The cycle count went from ${f.was} to ${f.now} ${since}: a restart or a counter wrap.`;
    case 'slow': return `The cycle count rose less than the elapsed time allows ${since}: the PLC was stopped or restarted in between.`;
    case 'cycleTimeChanged': return `The task cycle time changed from ${ms(f.was)} to ${ms(f.now)} ${since} (download); the counter is not compared.`;
    case 'onlineChange': return `The online change count went from ${f.was} to ${f.now} ${since}: an online change or download happened.`;
  }
}

export function stateText(o: { target: string; task: number; state: PlcStateReply; first: boolean; findings: StateFinding[]; clock: (ms: number) => string; names: ToolNames }): string {
  const { state: s, target } = o;
  const lines: string[] = [];
  const systemOff = s.systemState !== undefined && s.systemState !== 'Run';
  if (s.adsState === undefined) {
    // the PLC part could not be read (config mode, no PLC port, connection problem)
    const why = s.plcError ?? 'no answer';
    if (systemOff) {
      lines.push(systemLine(s.systemState!, target), `PLC: not reachable (${why}).`);
    } else if (s.systemState === 'Run' && s.plcAdsCode === 0x6) {
      lines.push(`PLC on ${target}: not reachable (${why}); the TwinCAT system runs, so the PLC port is missing: no PLC program on this port, or it is still starting.`);
    } else {
      lines.push(`PLC on ${target}: not reachable (${why}).`);
    }
    return lines.join('\n');
  }
  lines.push(`PLC state on ${target}: ${s.adsState} (device state ${s.deviceState ?? 0}).`);
  if (systemOff) lines.push(systemLine(s.systemState!));
  if (s.adsState !== 'Run') lines.push('The PLC is not running: values are not updated.');
  const parts: string[] = [];
  if (s.cycleTimeUs !== undefined) parts.push(`cycle time ${ms(s.cycleTimeUs)}`);
  if (s.cycleCount !== undefined) parts.push(`cycle count ${s.cycleCount}`);
  if (s.onlineChangeCount !== undefined) parts.push(`online changes ${s.onlineChangeCount}`);
  if (!parts.length) lines.push(`Task ${o.task}: ${s.taskNote ?? 'task counters not available'}`);
  else lines.push(`Task ${o.task}: ${parts.join(', ')}${s.taskNote ? `; ${s.taskNote}` : ''}.`);
  for (const f of o.findings) lines.push(findingText(f, o.clock));
  if (o.first) lines.push(`No earlier ${o.names.state} call for task ${o.task} on this target to compare with; call it again later to see a restart or an online change.`);
  return lines.join('\n');
}

export interface RunStateDeps {
  requires(feature: string): Promise<string | undefined>;
  plcState(task: number): Promise<PlcStateReply>;
  tracker: StateTracker;
  targetKey: string;
  target: string;
  clock: (ms: number) => string;
  names: ToolNames;
  wallMs(): number;
  monoMs(): number;
}

/** One ads_state call: the feature check first (an idle host is started by it), then the read, the comparison and the text. */
export async function runState(d: RunStateDeps, task: number): Promise<ToolText> {
  const missing = await d.requires('plcState');
  if (missing) return { text: `Cannot read the PLC state: ${missing}`, isError: true };
  try {
    const state = await d.plcState(task);
    const { first, findings } = d.tracker.observe(`${d.targetKey}#${task}`, state, d.wallMs(), d.monoMs());
    return { text: stateText({ target: d.target, task, state, first, findings, clock: d.clock, names: d.names }) };
  } catch (e) {
    return { text: `Error: ${(e as Error).message}`, isError: true };
  }
}
