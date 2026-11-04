import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpSession, McpTool } from '../src/core/mcp';

// ---- helpers ----

const tick = () => new Promise<void>(r => setImmediate(r));

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const echo: McpTool = {
  name: 'echo', description: 'Echoes the text.', inputSchema: { type: 'object' },
  call: async args => ({ text: `got ${JSON.stringify(args)}` }),
};

const req = (id: unknown, method: string, params?: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const note = (method: string, params?: unknown): string => JSON.stringify({ jsonrpc: '2.0', method, params });
const parse = (s: string | undefined) => JSON.parse(s ?? 'null');

/** A tool that stays open until `release()` and records its abort signal. */
function slowTool(name = 'slow') {
  const d = deferred<{ text: string }>();
  let started = 0;
  let signal: AbortSignal | undefined;
  const tool: McpTool = {
    name, description: 'Slow.', inputSchema: {},
    call: (_a, s) => { started++; signal = s; return d.promise; },
  };
  return { tool, release: () => d.resolve({ text: 'done' }), started: () => started, signal: () => signal };
}

// ---- tests ----

test('tools/list lists the tools', async () => {
  const s = new McpSession([echo]);
  const r = parse(await s.handle(req(1, 'tools/list')));
  assert.equal(r.id, 1);
  assert.deepEqual(r.result.tools, [{ name: 'echo', description: 'Echoes the text.', inputSchema: { type: 'object' } }]);
});

test('tools/call returns text content', async () => {
  const s = new McpSession([echo]);
  const r = parse(await s.handle(req(2, 'tools/call', { name: 'echo', arguments: { a: 1 } })));
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'got {"a":1}' }], isError: false });
});

test('tools/call marks errors', async () => {
  const bad: McpTool = { ...echo, name: 'bad', call: async () => ({ text: 'nope', isError: true }) };
  const s = new McpSession([bad]);
  const r = parse(await s.handle(req(3, 'tools/call', { name: 'bad' })));
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'nope');
});

test('unknown tool gives -32602', async () => {
  const s = new McpSession([echo]);
  const r = parse(await s.handle(req(4, 'tools/call', { name: 'missing' })));
  assert.equal(r.error.code, -32602);
  assert.equal(r.id, 4);
});

test('unknown method gives -32601', async () => {
  const s = new McpSession([echo]);
  const r = parse(await s.handle(req(5, 'resources/list')));
  assert.equal(r.error.code, -32601);
});

test('ping answers an empty result', async () => {
  const s = new McpSession([echo]);
  assert.deepEqual(parse(await s.handle(req(6, 'ping'))).result, {});
});

test('notification gets no reply', async () => {
  const s = new McpSession([echo]);
  assert.equal(await s.handle(note('notifications/initialized')), undefined);
  assert.equal(await s.handle(note('something/else')), undefined);
});

test('invalid JSON gives parse error', async () => {
  const s = new McpSession([echo]);
  const r = parse(await s.handle('{not json'));
  assert.equal(r.error.code, -32700);
  assert.equal(r.id, null);
});

test('batch gives invalid request', async () => {
  const s = new McpSession([echo]);
  assert.equal(parse(await s.handle('[]')).error.code, -32600);
  assert.equal(parse(await s.handle(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).error.code, -32600);
});

test('a message without method gives invalid request', async () => {
  const s = new McpSession([echo]);
  assert.equal(parse(await s.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).error.code, -32600);
});

test('cancelled notification aborts the running call', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const call = s.handle(req(7, 'tools/call', { name: 'slow' }));
  await tick();
  assert.equal(t.signal()?.aborted, false);
  assert.equal(await s.handle(note('notifications/cancelled', { requestId: 7 })), undefined);
  assert.equal(t.signal()?.aborted, true);
  t.release();
  await call;
});

test('tools/call without an id is refused', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const r = parse(await s.handle(note('tools/call', { name: 'slow' })));
  assert.equal(r.error.code, -32600);
  assert.equal(t.started(), 0);
});

test('a duplicate running id is refused', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const first = s.handle(req(8, 'tools/call', { name: 'slow' }));
  await tick();
  const second = parse(await s.handle(req(8, 'tools/call', { name: 'slow' })));
  assert.equal(second.error.code, -32600);
  assert.equal(t.started(), 1);
  assert.equal(t.signal()?.aborted, false);
  t.release();
  assert.equal(parse(await first).result.content[0].text, 'done');
});

test('ids 5 and "5" are different', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const a = s.handle(req(5, 'tools/call', { name: 'slow' }));
  const b = s.handle(req('5', 'tools/call', { name: 'slow' }));
  await tick();
  assert.equal(t.started(), 2);
  t.release();
  const [ra, rb] = [parse(await a), parse(await b)];
  assert.equal(ra.id, 5);
  assert.equal(rb.id, '5');
});

test('a finished id can be used again', async () => {
  const s = new McpSession([echo]);
  await s.handle(req(9, 'tools/call', { name: 'echo' }));
  assert.equal(parse(await s.handle(req(9, 'tools/call', { name: 'echo' }))).result.isError, false);
});

test('cancel with a malformed requestId is ignored', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const call = s.handle(req(10, 'tools/call', { name: 'slow' }));
  await tick();
  for (const p of [undefined, {}, { requestId: null }, { requestId: { a: 1 } }, { requestId: true }, 'x']) {
    assert.equal(await s.handle(note('notifications/cancelled', p)), undefined);
  }
  assert.equal(t.signal()?.aborted, false);
  t.release();
  await call;
});

test('an oversized reply becomes a tool error', async () => {
  const big: McpTool = { ...echo, name: 'big', call: async () => ({ text: 'ä'.repeat(400) }) };
  const s = new McpSession([big], 500);
  const line = await s.handle(req(11, 'tools/call', { name: 'big' }));
  const r = parse(line);
  assert.equal(r.id, 11);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'The result is too large to send. Ask for less.');
  assert.ok(Buffer.byteLength(line!, 'utf8') <= 500);
});

test('a reply at the limit is kept', async () => {
  const s = new McpSession([echo], 1000);
  const r = parse(await s.handle(req(12, 'tools/call', { name: 'echo' })));
  assert.equal(r.result.isError, false);
});

test('close aborts every running call', async () => {
  const a = slowTool('a');
  const b = slowTool('b');
  const s = new McpSession([a.tool, b.tool]);
  const ca = s.handle(req(1, 'tools/call', { name: 'a' }));
  const cb = s.handle(req(2, 'tools/call', { name: 'b' }));
  await tick();
  s.close();
  assert.equal(a.signal()?.aborted, true);
  assert.equal(b.signal()?.aborted, true);
  a.release();
  b.release();
  await Promise.all([ca, cb]);
});

test('a call after close starts with an aborted signal', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  s.close();
  const call = s.handle(req(1, 'tools/call', { name: 'slow' }));
  await tick();
  assert.equal(t.signal()?.aborted, true);
  t.release();
  await call;
});

test('a throwing tool gives an error result', async () => {
  const boom: McpTool = { ...echo, name: 'boom', call: async () => { throw new Error('kaputt'); } };
  const s = new McpSession([boom]);
  const r = parse(await s.handle(req(13, 'tools/call', { name: 'boom' })));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /kaputt/);
});

test('a cancel is handled while another call is still running', async () => {
  const t = slowTool();
  const s = new McpSession([t.tool]);
  const call = s.handle(req(14, 'tools/call', { name: 'slow' }));
  await tick();
  const other = s.handle(req(15, 'tools/call', { name: 'slow' }));
  await tick();
  // handle() never waits for the running calls: the cancel resolves at once
  assert.equal(await s.handle(note('notifications/cancelled', { requestId: 15 })), undefined);
  assert.equal(t.started(), 2);
  t.release();
  await Promise.all([call, other]);
});
