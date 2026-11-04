import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { proof, proofMatches, LineFramer, FrameTooLong, ExtHandshake, canonicalRoot, toolsFile, MAX_FRAME } from '../src/core/mcpWire';

// out/test/*.js -> repo root is three levels up from the compiled file
const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'testdata', 'mcp-wire.json'), 'utf8')) as
  { secret: string; extNonce: string; bridgeNonce: string; bridgeProof: string; extProof: string };

test('proof differs per role', () => {
  assert.notEqual(proof(fixture.secret, 'bridge', fixture.extNonce, fixture.bridgeNonce), proof(fixture.secret, 'ext', fixture.extNonce, fixture.bridgeNonce));
});

test('proof matches the golden fixture', () => {
  assert.equal(proof(fixture.secret, 'bridge', fixture.extNonce, fixture.bridgeNonce), fixture.bridgeProof);
  assert.equal(proof(fixture.secret, 'ext', fixture.extNonce, fixture.bridgeNonce), fixture.extProof);
});

test('proofMatches rejects different lengths', () => {
  assert.equal(proofMatches('abc', 'abc'), true);
  assert.equal(proofMatches('abc', 'abcd'), false);
  assert.equal(proofMatches('abc', ''), false);
  assert.equal(proofMatches('abc', undefined), false);
});

test('framer splits lines across chunks', () => {
  const f = new LineFramer();
  assert.deepEqual(f.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(f.push(':2}\r\n\n'), ['{"b":2}', '']);
  assert.deepEqual(f.push('tail'), []);
});

test('framer decodes UTF-8 split across chunks', () => {
  const bytes = Buffer.from('ä€\n', 'utf8');
  const f = new LineFramer();
  assert.deepEqual(f.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(f.push(bytes.subarray(1, 4)), []);
  assert.deepEqual(f.push(bytes.subarray(4)), ['ä€']);
});

test('framer throws on a line over the limit', () => {
  assert.throws(() => new LineFramer(10).push('x'.repeat(11)), FrameTooLong);
  assert.throws(() => new LineFramer(10).push('x'.repeat(11) + '\n'), FrameTooLong);
  assert.deepEqual(new LineFramer(10).push('x'.repeat(10) + '\n'), ['x'.repeat(10)]);
  assert.equal(MAX_FRAME, 1_048_576);
});

test('framer counts the limit in bytes', () => {
  assert.throws(() => new LineFramer(10).push('ä'.repeat(6)), FrameTooLong);
});

const bridgeLine = (extNonce: string, proofValue: string) =>
  JSON.stringify({ hello: 'iecode-bridge', protocol: 1, nonce: fixture.bridgeNonce, proof: proofValue });

test('handshake accepts the right bridge proof and replies with the ext proof', () => {
  const h = new ExtHandshake(fixture.secret, fixture.extNonce);
  assert.deepEqual(JSON.parse(h.first()), { hello: 'iecode-ext', nonce: fixture.extNonce });
  const r = h.onLine(bridgeLine(fixture.extNonce, fixture.bridgeProof));
  assert.equal(r.done, true);
  assert.deepEqual(JSON.parse(r.reply!), { ok: true, proof: fixture.extProof });
});

test('handshake fails on a wrong proof', () => {
  const h = new ExtHandshake(fixture.secret, fixture.extNonce);
  const r = h.onLine(bridgeLine(fixture.extNonce, fixture.extProof));
  assert.deepEqual(r, { fail: true });
  assert.equal(r.reply, undefined);
  // once failed, even the right proof is refused
  assert.deepEqual(h.onLine(bridgeLine(fixture.extNonce, fixture.bridgeProof)), { fail: true });
});

test('handshake fails on a malformed line', () => {
  for (const line of ['not json', '[]', '{}', JSON.stringify({ hello: 'iecode-bridge', protocol: '1', nonce: 'x', proof: 'y' }),
    JSON.stringify({ hello: 'other', protocol: 1, nonce: 'x', proof: 'y' })]) {
    assert.deepEqual(new ExtHandshake(fixture.secret, fixture.extNonce).onLine(line), { fail: true }, line);
  }
});

test('handshake uses a fresh nonce by default', () => {
  assert.notEqual(new ExtHandshake(fixture.secret).first(), new ExtHandshake(fixture.secret).first());
});

test('canonicalRoot ignores drive case and trailing separator', () => {
  const same = (p: string) => p;
  assert.equal(canonicalRoot('C:\\Work\\Plant\\', same), 'c:\\Work\\Plant');
  assert.equal(canonicalRoot('c:/Work/Plant', same), 'c:\\Work\\Plant');
  assert.equal(canonicalRoot('C:\\', same), 'c:\\');
});

test('canonicalRoot resolves through realpath', () => {
  assert.equal(canonicalRoot('C:\\link\\', p => p.startsWith('C:\\link') ? 'D:\\real\\Plant' : p), 'd:\\real\\Plant');
  assert.equal(canonicalRoot('C:\\gone', () => { throw new Error('ENOENT'); }), 'c:\\gone');
});

test('toolsFile is the tools/list result', () => {
  const text = toolsFile([{ name: 'ads_read', description: 'Reads.', inputSchema: { type: 'object' } }]);
  assert.deepEqual(JSON.parse(text), { tools: [{ name: 'ads_read', description: 'Reads.', inputSchema: { type: 'object' } }] });
});
