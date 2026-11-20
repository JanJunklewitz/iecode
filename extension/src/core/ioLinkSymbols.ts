// The PLC side of an IO link as a symbol path, shared by the IO link checks and the impact view.
import type { TmcVar } from './tmc';
import type { TwinCatProject } from './projects';
import type { Unit, WorkspaceModel } from './workspace';

export interface PlcLinkSide { plc: string; area: string; path: string }

/** `TIPC^PLC1^PLC1 Instance^PlcTask Inputs^MAIN.bStart` -> plc, area, path. Undefined for safety links and IO sides. */
export function parsePlcLinkSide(side: string): PlcLinkSide | undefined {
  const m = /^TIPC\^([^^]+)\^\1 Instance\^([^^]+ (?:Inputs|Outputs))\^(.+)$/.exec(side);
  return m ? { plc: m[1], area: m[2], path: m[3] } : undefined;
}

/** Lower-case, `[n]` removed, `^` as `.`: the key under which a link path and a symbol are compared. */
export function normalizeLinkPath(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '').replace(/\^/g, '.').toLowerCase();
}

/** The longest prefix of the normalized path that is a symbol; `viaParent` when the match is not the whole path. */
export function resolveLinkSymbol(path: string, symbols: Map<string, TmcVar>): { symbol?: TmcVar; viaParent: boolean } {
  const parts = normalizeLinkPath(path).split('.');
  for (let n = parts.length; n > 0; n--) {
    const symbol = symbols.get(parts.slice(0, n).join('.'));
    if (symbol) return { symbol, viaParent: n < parts.length };
  }
  return { symbol: undefined, viaParent: false };
}

/** The TwinCAT project that contains the unit's PLC (PLC and IO usually share one .tsproj) and the PLC item name used in `TIPC^<plc>^` paths. */
export function systemProjectOf(model: Pick<WorkspaceModel, 'solutions'>, unit: Unit): { project: TwinCatProject; plcName: string } | undefined {
  const sln = unit.solution ? model.solutions.find(s => s.file === unit.solution!.file) ?? unit.solution : undefined;
  const project = sln?.projects.find(p => !p.plcOnly && p.plcs.some(x => x.file === unit.plc.file));
  return project ? { project, plcName: unit.plc.itemName ?? unit.plc.name } : undefined;
}
