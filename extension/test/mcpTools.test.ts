import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpTools, descriptorsFromManifest, gatePolicyFor, AdsToolFns, ToolDescriptor } from '../src/core/mcpTools';
import { McpSession } from '../src/core/mcp';
import { GateDeps, GatePolicy, WriteGate, WriteOp, WriteOutcomeUnknown, WriteResult } from '../src/core/writeGate';
import { WriteDecision } from '../src/core/adswatch';

// ---- helpers ----

class FakeClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => { const id = this.next++; this.timers.push({ at: this.t + ms, fn, id }); return id; };
  clearTimeout = (h: unknown) => { this.timers = this.timers.filter(x => x.id !== h); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter(x => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(r => setImmediate(r));

const POLICY: GatePolicy = { dialogMs: 100_000, operationMs: 150_000, maxQueued: 10 };
const descriptors: ToolDescriptor[] = ['symbols', 'watch', 'read', 'scope', 'wait', 'write', 'config', 'preset'].map(x => ({
  name: `ads_${x}`, description: `Description of ${x}.`, inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
}));
const fns = (over: Partial<AdsToolFns> = {}): AdsToolFns => ({
  symbols: async i => ({ text: `symbols ${i.filter}` }),
  watch: async i => ({ text: `watch ${JSON.stringify(i)}` }),
  read: async i => ({ text: `read ${JSON.stringify(i)}` }),
  scope: i => ({ text: `scope ${JSON.stringify(i)}` }),
  wait: async i => ({ text: `wait ${i.symbol}` }),
  config: async i => ({ text: `config ${JSON.stringify(i)}` }),
  preset: async i => ({ text: `preset ${JSON.stringify(i)}` }),
  ...over,
});

interface Rig { session: McpSession; sent: { op: WriteOp }[]; confirms: Deferred<boolean>[]; late: string[]; clock: FakeClock; decision: { v: WriteDecision }; send: { impl: GateDeps['send'] } }

function rig(over: Partial<AdsToolFns> = {}, decision: WriteDecision = 'allow'): Rig {
  const clock = new FakeClock();
  const state: Rig = { sent: [], confirms: [], late: [], clock, decision: { v: decision }, send: { impl: async () => ({ kind: 'written', readBack: '1' }) } } as unknown as Rig;
  const gate = new WriteGate({
    decision: () => state.decision.v,
    targetKey: () => 'A:851',
    confirm: () => { const d = deferred<boolean>(); state.confirms.push(d); return d.promise; },
    send: async (op, beforeSend) => { state.sent.push({ op }); return state.send.impl(op, beforeSend); },
    lateApproval: (_op, reason) => { state.late.push(reason); },
  }, POLICY, clock);
  state.session = new McpSession(buildMcpTools({ descriptors, tools: fns(over), gate, targetKey: () => 'A:851' }));
  return state;
}

const call = (id: number, name: string, args?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const result = async (p: Promise<string | undefined>) => JSON.parse((await p) ?? 'null').result as { content: { text: string }[]; isError: boolean };

// ---- tests ----

test('tools/list names the eight ads_ tools with their schemas', async () => {
  const r = rig();
  const list = JSON.parse((await r.session.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })))!).result.tools;
  assert.deepEqual(list.map((t: { name: string }) => t.name), ['ads_symbols', 'ads_watch', 'ads_read', 'ads_scope', 'ads_wait', 'ads_write', 'ads_config', 'ads_preset']);
  assert.deepEqual(list[5].inputSchema, descriptors[5].inputSchema);
  assert.equal(list[0].description, 'Description of symbols.');
});

test('a missing descriptor is a build error', () => {
  assert.throws(() => buildMcpTools({ descriptors: descriptors.filter(d => d.name !== 'ads_read'), tools: fns(), gate: undefined as never, targetKey: () => '' }), /ads_read/);
});

test('read tools pass validated arguments and refuse invalid ones', async () => {
  const r = rig();
  assert.equal((await result(r.session.handle(call(1, 'ads_symbols', { filter: 'MAIN' })))).content[0].text, 'symbols MAIN');
  assert.equal((await result(r.session.handle(call(2, 'ads_symbols')))).content[0].text, 'symbols ');
  const bad = await result(r.session.handle(call(3, 'ads_read', { symbols: 'MAIN.x' })));
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Invalid arguments: symbols must be an array of strings/);
});

test("ads_wait passes validated arguments and the call's signal", async () => {
  const seen: { input: unknown; signal: unknown }[] = [];
  const r = rig({ wait: async (input, signal) => { seen.push({ input, signal }); return { text: 'waited' }; } });
  const res = await result(r.session.handle(call(20, 'ads_wait', { symbol: 'P', condition: '= TRUE' })));
  assert.equal(res.content[0].text, 'waited');
  assert.equal(seen.length, 1);
  assert.equal((seen[0].input as { timeoutSeconds: number }).timeoutSeconds, 30);
  assert.equal((seen[0].input as { symbol: string }).symbol, 'P');
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test("ads_watch passes the parsed fields and the call's signal", async () => {
  const seen: { input: unknown; signal: unknown }[] = [];
  const r = rig({ watch: async (input, signal) => { seen.push({ input, signal }); return { text: 'watched' }; } });
  const res = await result(r.session.handle(call(22, 'ads_watch', { add: ['A'], list: true })));
  assert.equal(res.content[0].text, 'watched');
  assert.deepEqual(seen[0].input, { add: ['A'], remove: [], list: true });
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test('ads_wait with a bad condition never reaches the tool', async () => {
  let reached = false;
  const r = rig({ wait: async () => { reached = true; return { text: 'x' }; } });
  const res = await result(r.session.handle(call(21, 'ads_wait', { symbol: 'P', condition: 'bogus' })));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Invalid arguments:/);
  assert.equal(reached, false);
});

test('ads_write reaches gate.run with via MCP and the bound target', async () => {
  const r = rig();
  const res = await result(r.session.handle(call(4, 'ads_write', { symbol: 'MAIN.x', value: '5' })));
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /^Written\. MAIN\.x reads back as 1/);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].op, { symbol: 'MAIN.x', value: '5', targetKey: 'A:851', via: 'MCP' });
});

test('ads_write with invalid arguments never reaches the gate', async () => {
  const r = rig();
  const res = await result(r.session.handle(call(5, 'ads_write', { symbol: 'MAIN.x' })));
  assert.equal(res.isError, true);
  assert.equal(r.sent.length, 0);
});

test('ads_write that is refused sets isError', async () => {
  const r = rig({}, 'refuse');
  const res = await result(r.session.handle(call(6, 'ads_write', { symbol: 'MAIN.x', value: '5' })));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Not written: AI writes are off/);
  assert.equal(r.sent.length, 0);
});

test('closing the session refuses a write that is still waiting for its dialog', async () => {
  const r = rig({}, 'confirm');
  const pending = r.session.handle(call(7, 'ads_write', { symbol: 'MAIN.x', value: '5' }));
  await tick();
  assert.equal(r.confirms.length, 1);
  r.session.close();
  const res = await result(pending);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Not written/);
  // the user clicks Write after the connection is gone: still nothing is sent
  r.confirms[0].resolve(true);
  await tick();
  assert.equal(r.sent.length, 0);
  assert.equal(r.late.length, 1);
});

test('a cancel line aborts a queued write while another call is running', async () => {
  const r = rig({}, 'confirm');
  const first = r.session.handle(call(8, 'ads_write', { symbol: 'MAIN.a', value: '1' }));
  await tick();
  const second = r.session.handle(call(9, 'ads_write', { symbol: 'MAIN.b', value: '2' }));
  await tick();
  assert.equal(r.confirms.length, 1); // the second waits behind the first dialog
  await r.session.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }));
  const res = await result(second);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cancelled/);
  // the first is untouched: confirm it and it is written
  r.confirms[0].resolve(true);
  assert.equal((await result(first)).isError, false);
  assert.deepEqual(r.sent.map(s => s.op.symbol), ['MAIN.a']);
});

test('a call that throws gives an error result', async () => {
  const r = rig({ symbols: async () => { throw new Error('host exploded'); } });
  const res = await result(r.session.handle(call(10, 'ads_symbols', {})));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /host exploded/);
});

test('a write whose send never answers ends as outcome unknown, not as not written', async () => {
  const r = rig();
  const reply = deferred<WriteResult>();
  let passedBeforeSend = false;
  r.send.impl = async (_op, beforeSend) => {
    assert.equal(beforeSend(), undefined);
    passedBeforeSend = true;
    return reply.promise;
  };
  const pending = r.session.handle(call(11, 'ads_write', { symbol: 'MAIN.x', value: '5' }));
  await tick();
  assert.equal(passedBeforeSend, true);
  // past the gate's operation deadline: once sent, the gate does not time the write out
  r.clock.advance(200_000);
  reply.reject(new WriteOutcomeUnknown('the host did not answer'));
  const res = await result(pending);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Outcome unknown: the host did not answer/);
  assert.doesNotMatch(res.content[0].text, /Not written/);
});

test('policy keeps 150/120 s for a long timeout', () => {
  assert.deepEqual(gatePolicyFor(300_000), { dialogMs: 120_000, operationMs: 150_000, maxQueued: 10 });
  assert.deepEqual(gatePolicyFor(undefined), { dialogMs: 120_000, operationMs: 150_000, maxQueued: 10 });
});

test('policy shrinks to the tool timeout', () => {
  assert.deepEqual(gatePolicyFor(100_000), { dialogMs: 85_000, operationMs: 90_000, maxQueued: 10 });
  assert.deepEqual(gatePolicyFor(160_000), { dialogMs: 120_000, operationMs: 150_000, maxQueued: 10 });
});

test('policy is undefined when the timeout leaves no room for a dialog', () => {
  assert.equal(gatePolicyFor(19_999), undefined);
  assert.equal(gatePolicyFor(5_000), undefined);
  assert.deepEqual(gatePolicyFor(20_000), { dialogMs: 5_000, operationMs: 10_000, maxQueued: 10 });
  assert.deepEqual(gatePolicyFor(21_000), { dialogMs: 6_000, operationMs: 11_000, maxQueued: 10 });
});

test('the manifest declares the eight tools in client-neutral words', () => {
  // out/test/*.js -> the extension's package.json is two levels up
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const found = descriptorsFromManifest(manifest);
  assert.deepEqual(found.map(d => d.name), ['ads_symbols', 'ads_watch', 'ads_read', 'ads_scope', 'ads_wait', 'ads_write', 'ads_config', 'ads_preset']);
  const wait = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).contributes.languageModelTools.find((t: { name: string }) => t.name === 'iecode_ads_wait');
  assert.deepEqual(wait.inputSchema.required, ['symbol', 'condition']);
  const watch = found.find(d => d.name === 'ads_watch') as { inputSchema: { properties: { list: { type: string } } } };
  assert.equal(watch.inputSchema.properties.list.type, 'boolean');
  const props = watch.inputSchema.properties as unknown as Record<string, { type: string }>;
  assert.equal(props.clearAi.type, 'boolean');
  assert.equal(props.force.type, 'boolean');
  assert.deepEqual(Object.keys(props).sort(), ['add', 'clearAi', 'enable', 'force', 'group', 'list', 'remove', 'removeGroup']);
  assert.equal((props.group as unknown as { maxLength: number }).maxLength, 64);
  for (const d of found) {
    assert.ok(d.description.length > 20);
    assert.doesNotMatch(d.description, /#?ads(Watch|Scope|Read|Write|Symbols|Wait|Config|Preset)\b/, `${d.name} names a Copilot tool`);
    assert.doesNotMatch(d.description, /Always Allow/, `${d.name} carries a per-client approval detail`);
  }
});

test('ads_scope passes every new option and never sees an invalid combination', async () => {
  const seen: unknown[] = [];
  const r = rig({ scope: i => { seen.push(i); return { text: 'scoped' }; } });
  const all = await result(r.session.handle(call(30, 'ads_scope', { symbols: ['a'], seconds: 30, maxRows: 5, decimals: 2, edges: true })));
  assert.equal(all.content[0].text, 'scoped');
  assert.deepEqual(seen, [{ symbols: ['a'], seconds: 30, maxRows: 5, decimals: 2, edges: true }]);
  await result(r.session.handle(call(31, 'ads_scope', { changesOnly: true })));
  assert.deepEqual(seen.at(-1), { symbols: [], changesOnly: true });
  const before = seen.length;
  const both = await result(r.session.handle(call(32, 'ads_scope', { edges: true, changesOnly: true })));
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /edges and changesOnly cannot be combined/);
  const bad = await result(r.session.handle(call(33, 'ads_scope', { maxRows: 'x' })));
  assert.equal(bad.isError, true);
  assert.equal(seen.length, before);
});

test("ads_config passes validated arguments and the call's signal", async () => {
  const seen: { input: unknown; signal: unknown }[] = [];
  const r = rig({ config: async (input, signal) => { seen.push({ input, signal }); return { text: 'configured' }; } });
  const res = await result(r.session.handle(call(30, 'ads_config', { pollMs: 20 })));
  assert.equal(res.content[0].text, 'configured');
  assert.deepEqual(seen[0].input, { pollMs: 20 });
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test('ads_config with a bad argument never reaches the tool', async () => {
  let reached = false;
  const r = rig({ config: async () => { reached = true; return { text: 'x' }; } });
  const res = await result(r.session.handle(call(31, 'ads_config', { pollMs: 'fast' })));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^Invalid arguments: pollMs must be a finite number/);
  assert.equal(reached, false);
});

test('ads_preset passes validated arguments and refuses a preset without a path', async () => {
  const seen: unknown[] = [];
  const r = rig({ preset: async i => { seen.push(i); return { text: 'preset ok' }; } });
  assert.equal((await result(r.session.handle(call(40, 'ads_preset', { path: 'MAIN.fbSeq', preset: 'seq' })))).content[0].text, 'preset ok');
  assert.deepEqual(seen, [{ path: 'MAIN.fbSeq', preset: 'seq' }]);
  const bad = await result(r.session.handle(call(41, 'ads_preset', { preset: 'seq' })));
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^Invalid arguments: path is required with preset/);
  assert.equal(seen.length, 1);
});
