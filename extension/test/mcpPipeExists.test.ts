import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pipeExists, servePipe } from '../src/core/mcpPipe';

const name = () => `iecode-test-${randomBytes(6).toString('hex')}`;

test('pipeExists finds a pipe in the listing and does not connect to it', async () => {
  const n = name();
  let accepted = 0;
  const server = await servePipe(`\\\\.\\pipe\\${n}`, 'AAAA', () => { accepted++; });
  try {
    assert.equal(pipeExists(`\\\\.\\pipe\\${n}`), true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(accepted, 0);
  } finally {
    await server.close();
  }
  assert.equal(pipeExists(`\\\\.\\pipe\\${n}`), false);
});

test('pipeExists compares names case-insensitively and with an injected listing', () => {
  assert.equal(pipeExists('\\\\.\\pipe\\Iecode-MCP-a1', () => ['other', 'iecode-mcp-a1']), true);
  assert.equal(pipeExists('\\\\.\\pipe\\iecode-mcp-a1', () => ['other']), false);
});

test('pipeExists says yes when the listing fails: unknown is not gone', () => {
  assert.equal(pipeExists('\\\\.\\pipe\\iecode-mcp-a1', () => { throw new Error('EACCES'); }), true);
});
