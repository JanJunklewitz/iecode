import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, PROTOCOL_TABLE, ProtocolTable, negotiate, featureMissingText, tableProblems } from '../src/core/hostProtocol';

const BASE = ['watch', 'read', 'write', 'interval'];
// a synthetic table proves the rules without depending on what the real table offers today
const T2: ProtocolTable = {
  1: { ops: BASE, features: [] },
  2: { ops: [...BASE, 'futureOp'], features: ['futureThing'] },
};

test('the real table is well formed, deep-frozen and PROTOCOL is its highest entry', () => {
  assert.deepEqual(tableProblems(PROTOCOL_TABLE), []);
  assert.equal(PROTOCOL, Math.max(...Object.keys(PROTOCOL_TABLE).map(Number)));
  assert.ok(Object.isFrozen(PROTOCOL_TABLE) && Object.isFrozen(PROTOCOL_TABLE[1]) && Object.isFrozen(PROTOCOL_TABLE[1].ops));
});

test('entry 1 is pinned: a released protocol never changes', () => {
  assert.deepEqual(PROTOCOL_TABLE[1], { ops: ['watch', 'read', 'write', 'interval'], features: [] });
});

test('tableProblems finds gaps, dropped features and empty entries', () => {
  assert.match(tableProblems({ 1: { ops: BASE, features: [] }, 3: { ops: BASE, features: [] } })[0], /gap/);
  assert.match(tableProblems({ 1: { ops: BASE, features: ['a'] }, 2: { ops: BASE, features: [] } })[0], /protocol 2 drops "a"/);
  assert.match(tableProblems({ 1: { ops: [], features: [] } })[0], /protocol 1 has no ops/);
});

test('a protocol-1 host serves scalar read, write, watch and wait', () => {
  const n = negotiate(1, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  // ads_wait needs no op beyond watch; the scalar write is op "write"
  for (const op of ['watch', 'read', 'write', 'interval']) assert.equal(n.caps.supportsOp(op), true, op);
  assert.equal(n.caps.supportsOp('futureOp'), false);
});

test('a feature the old host lacks reports "needs a newer iecode CLI"', () => {
  const n = negotiate(1, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  assert.equal(n.caps.supports('futureThing'), false);
  assert.equal(n.caps.missing('futureThing'),
    'this needs a newer iecode CLI: futureThing (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…"');
  assert.equal(featureMissingText('nobodyOffersThis', 1, T2), 'this needs a newer iecode CLI: nobodyOffersThis. Update it with "IECode: Install CLI…"');
});

test('the current host works with every feature', () => {
  const n = negotiate(2, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  assert.equal(n.caps.supports('futureThing'), true);
  assert.equal(n.caps.supportsOp('futureOp'), true);
  assert.equal(n.caps.missing('futureThing'), undefined);
});

test('a newer host is refused with "update the extension" and no install action', () => {
  assert.deepEqual(negotiate(3, T2), { ok: false, error: 'The iecode CLI speaks ADS host protocol 3, newer than this extension (2). Update the extension.' });
});

test('a host with an unreadable or unknown protocol is refused with the install action', () => {
  for (const p of [0, -1, 1.5, '2', null, undefined, NaN]) {
    const n = negotiate(p, T2);
    assert.equal(n.ok, false, String(p));
    if (!n.ok) { assert.match(n.error, /^The iecode CLI sent an unknown ADS host protocol version \(/); assert.equal(n.action, 'install'); }
  }
  const gap = negotiate(2, { 1: { ops: BASE, features: [] }, 3: { ops: BASE, features: [] } });
  assert.equal(gap.ok, false);
});

test('an unknown feature name is never supported', () => {
  const n = negotiate(2, T2);
  assert.ok(n.ok);
  if (n.ok) assert.equal(n.caps.supports('typo'), false);
});

test('the real table accepts its own protocol and refuses the next one', () => {
  assert.equal(negotiate(PROTOCOL).ok, true);
  assert.equal(negotiate(1).ok, true);
  assert.equal(negotiate(PROTOCOL + 1).ok, false);
});
