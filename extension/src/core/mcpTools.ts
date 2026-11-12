// The six ADS tools as MCP tools, and the write-gate policy that fits the MCP client's tool timeout. Pure (no VS Code API):
// the tool functions, the gate and the bound target come in, so the riskiest seam, ads_write into the gate, is unit-tested.

import { McpTool } from './mcp';
import { ToolText } from './adsToolText';
import type { WaitCondition } from './waitCondition';
import { parseReadInput, parseScopeInput, parseSymbolsInput, parseWaitInput, parseWatchInput, parseWriteInput, Parsed, ScopeArgs, WatchRequest } from './toolInput';
import { GatePolicy, MIN_DIALOG_MS, WriteGate, WriteOp, writeResultIsError, writeResultText } from './writeGate';

/** A tool as declared in package.json (`languageModelTools`), `iecode_ads_<x>` already renamed to `ads_<x>`. */
export interface ToolDescriptor { name: string; description: string; inputSchema: object }

/** The read-side tool logic of `adsTools()`; write goes through the gate. */
export interface AdsToolFns {
  symbols(input: { filter: string }): Promise<ToolText>;
  watch(input: WatchRequest, signal: AbortSignal): Promise<ToolText>;
  read(input: { symbols?: string[] }): Promise<ToolText>;
  scope(input: Partial<ScopeArgs>): ToolText | Promise<ToolText>;
  wait(input: { symbol: string; condition: WaitCondition; timeoutSeconds: number }, signal: AbortSignal): Promise<ToolText>;
}

const invalid = (error: string): { text: string; isError: true } => ({ text: `Invalid arguments: ${error}`, isError: true });

export function buildMcpTools(d: { descriptors: ToolDescriptor[]; tools: AdsToolFns; gate: WriteGate; targetKey(): string }): McpTool[] {
  const descriptor = (name: string): ToolDescriptor => {
    const found = d.descriptors.find(x => x.name === name);
    if (!found) throw new Error(`package.json declares no tool ${name}`);
    return found;
  };
  const read = <T>(name: string, parse: (raw: unknown) => Parsed<T>, run: (v: T, signal: AbortSignal) => ToolText | Promise<ToolText>): McpTool => {
    const { description, inputSchema } = descriptor(name);
    return {
      name, description, inputSchema,
      async call(args, signal) {
        const p = parse(args);
        return p.ok ? run(p.value, signal) : invalid(p.error);
      },
    };
  };

  const write = descriptor('ads_write');
  return [
    read('ads_symbols', parseSymbolsInput, v => d.tools.symbols(v)),
    read('ads_watch', parseWatchInput, (v, signal) => d.tools.watch(v, signal)),
    read('ads_read', parseReadInput, v => d.tools.read(v)),
    read('ads_scope', parseScopeInput, v => d.tools.scope(v)),
    read('ads_wait', parseWaitInput, (v, signal) => d.tools.wait(v, signal)),
    {
      name: 'ads_write', description: write.description, inputSchema: write.inputSchema,
      async call(args, signal) {
        const p = parseWriteInput(args);
        if (!p.ok) return invalid(p.error);
        const op: WriteOp = { symbol: p.value.symbol, value: p.value.value, targetKey: d.targetKey(), via: 'MCP' };
        const result = await d.gate.run(op, signal);
        return { text: writeResultText(result, op), isError: writeResultIsError(result) };
      },
    },
  ];
}

/**
 * Gate deadlines that end before the client gives up on the call, so it never abandons a call while its dialog is open.
 * `undefined`: the timeout leaves no room for a dialog, AI writes must be refused (reads still work). An unknown timeout
 * keeps the full 150 s / 120 s.
 */
export function gatePolicyFor(timeoutMs: number | undefined, maxQueued = 10): GatePolicy | undefined {
  const operationMs = Math.min(150_000, timeoutMs === undefined ? Infinity : timeoutMs - 10_000);
  const dialogMs = Math.min(120_000, operationMs - 5_000);
  if (dialogMs < MIN_DIALOG_MS) return undefined;
  return { dialogMs, operationMs, maxQueued };
}

/** The `iecode_ads_*` entries of `contributes.languageModelTools`, renamed to `ads_*` for MCP. */
export function descriptorsFromManifest(manifest: unknown): ToolDescriptor[] {
  const tools = (manifest as { contributes?: { languageModelTools?: { name?: string; modelDescription?: string; inputSchema?: object }[] } })
    ?.contributes?.languageModelTools ?? [];
  const out: ToolDescriptor[] = [];
  for (const t of tools) {
    if (typeof t.name !== 'string' || !t.name.startsWith('iecode_ads_') || typeof t.modelDescription !== 'string' || !t.inputSchema) continue;
    out.push({ name: t.name.slice('iecode_'.length), description: t.modelDescription, inputSchema: t.inputSchema });
  }
  return out;
}

/** A `ping_tool` call of 300 s completed in Claude Code 2.1.306 and 2.1.318 without a timeout (spike): a measured lower bound. */
export const CLAUDE_TOOL_TIMEOUT_MS = 300_000;
