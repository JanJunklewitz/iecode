// One MCP session over any line transport: JSON-RPC handling for the ADS tools. Pure (no VS Code API, no I/O), so it is
// unit-tested and a different transport can reuse it. `initialize` is answered by the bridge, not here.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
}

type Id = string | number;

const TOO_LARGE = 'The result is too large to send. Ask for less.';

const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number';
/** 5 and "5" are different ids, so the key carries the type. */
const keyOf = (id: Id): string => `${typeof id}:${id}`;

const failure = (id: Id | null, code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
const success = (id: Id, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result });

export class McpSession {
  private readonly running = new Map<string, AbortController>();
  private closed = false;

  constructor(private readonly tools: McpTool[], private readonly maxReplyBytes = 1_048_576) {}

  /** One MCP line in; the reply line, or undefined for notifications. Calls never wait for each other. */
  async handle(line: string): Promise<string | undefined> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return failure(null, -32700, 'Parse error');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof (msg as { method?: unknown }).method !== 'string') {
      const id = (msg as { id?: unknown } | null)?.id;
      return failure(!Array.isArray(msg) && isId(id) ? id : null, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg as { id?: unknown; method: string; params?: unknown };
    const hasId = isId(id);

    switch (method) {
      case 'tools/list':
        return hasId ? success(id, { tools: this.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }) : undefined;
      case 'ping':
        return hasId ? success(id, {}) : undefined;
      case 'tools/call':
        // A call without an id could never be answered or cancelled unambiguously.
        return hasId ? this.callTool(id, params) : failure(null, -32600, 'tools/call needs an id');
      case 'notifications/cancelled':
        this.cancel(params);
        return undefined;
      default:
        return hasId ? failure(id, -32601, `Method not found: ${method}`) : undefined;
    }
  }

  /** The connection closed: every running call is aborted, later calls start aborted. */
  close(): void {
    this.closed = true;
    for (const c of this.running.values()) c.abort();
  }

  private cancel(params: unknown): void {
    const requestId = params && typeof params === 'object' ? (params as { requestId?: unknown }).requestId : undefined;
    if (isId(requestId)) this.running.get(keyOf(requestId))?.abort();
  }

  private async callTool(id: Id, params: unknown): Promise<string> {
    const p = (params && typeof params === 'object' ? params : {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof p.name === 'string' ? this.tools.find(t => t.name === p.name) : undefined;
    if (!tool) return failure(id, -32602, `Unknown tool: ${String(p.name)}`);
    const key = keyOf(id);
    if (this.running.has(key)) return failure(id, -32600, 'A call with this id is already running');

    // Registered before the first await, so a cancel or a duplicate arriving right after finds it.
    const controller = new AbortController();
    if (this.closed) controller.abort();
    this.running.set(key, controller);
    let result: { text: string; isError?: boolean };
    try {
      result = await tool.call(p.arguments, controller.signal);
    } catch (e) {
      result = { text: e instanceof Error ? e.message : String(e), isError: true };
    } finally {
      this.running.delete(key);
    }
    const reply = success(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true });
    if (Buffer.byteLength(reply, 'utf8') <= this.maxReplyBytes) return reply;
    return success(id, { content: [{ type: 'text', text: TOO_LARGE }], isError: true });
  }
}
