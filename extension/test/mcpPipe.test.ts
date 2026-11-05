import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { servePipe, PipeConnection, PipeServer } from '../src/core/mcpPipe';
import { proof, proofMatches, LineFramer, FrameTooLong, MAX_FRAME } from '../src/core/mcpWire';

const SECRET = randomBytes(32).toString('base64');
const pipeName = () => `\\\\.\\pipe\\iecode-test-${randomBytes(6).toString('hex')}`;

const servers: PipeServer[] = [];
after(async () => { for (const s of servers) await s.close(); });

/** A line-reading test client. */
class Client {
  readonly socket: net.Socket;
  private readonly framer = new LineFramer(4 * MAX_FRAME);
  private readonly lines: string[] = [];
  private waiting: ((l: string) => void)[] = [];
  closed = false;
  private closeWaiters: (() => void)[] = [];

  constructor(path: string) {
    this.socket = net.connect(path);
    this.socket.on('data', c => {
      for (const l of this.framer.push(c)) {
        const w = this.waiting.shift();
        if (w) w(l); else this.lines.push(l);
      }
    });
    this.socket.on('error', () => { /* closed by the server */ });
    this.socket.on('close', () => { this.closed = true; this.closeWaiters.forEach(f => f()); });
  }

  next(): Promise<string> {
    const l = this.lines.shift();
    return l !== undefined ? Promise.resolve(l) : new Promise(r => this.waiting.push(r));
  }

  whenClosed(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise(r => this.closeWaiters.push(r));
  }

  send(line: string) { this.socket.write(line + '\n'); }
  end() { this.socket.destroy(); }
}

async function start(onSession: (c: PipeConnection) => void, handshakeMs?: number) {
  const path = pipeName();
  const server = await servePipe(path, SECRET, onSession, { handshakeMs });
  servers.push(server);
  return path;
}

/** Runs the bridge side of the handshake; resolves with the extension's reply line. */
async function handshake(c: Client, secret = SECRET): Promise<{ ok: boolean; proof: string; extNonce: string; bridgeNonce: string }> {
  const hello = JSON.parse(await c.next()) as { hello: string; nonce: string };
  assert.equal(hello.hello, 'iecode-ext');
  const bridgeNonce = randomBytes(16).toString('base64');
  c.send(JSON.stringify({ hello: 'iecode-bridge', protocol: 1, nonce: bridgeNonce, proof: proof(secret, 'bridge', hello.nonce, bridgeNonce) }));
  const reply = JSON.parse(await c.next());
  return { ...reply, extNonce: hello.nonce, bridgeNonce };
}

/** A promise for the first authenticated session plus the lines it received. */
function sessionProbe() {
  const lines: string[] = [];
  let resolve!: (c: PipeConnection) => void;
  const connection = new Promise<PipeConnection>(r => { resolve = r; });
  return { lines, connection, onSession: (c: PipeConnection) => { c.onLine(l => lines.push(l)); resolve(c); } };
}

test('servePipe authenticates a client that knows the secret', async () => {
  const probe = sessionProbe();
  const path = await start(probe.onSession);
  const client = new Client(path);
  const r = await handshake(client);
  assert.equal(r.ok, true);
  assert.ok(proofMatches(proof(SECRET, 'ext', r.extNonce, r.bridgeNonce), r.proof));
  const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  client.send(ping);
  const conn = await probe.connection;
  conn.send('{"reply":1}');
  assert.equal(await client.next(), '{"reply":1}');
  for (let i = 0; i < 50 && probe.lines.length === 0; i++) await new Promise(r2 => setTimeout(r2, 10));
  assert.deepEqual(probe.lines, [ping]);
  client.end();
});

test('servePipe closes a client with a wrong proof without a reply', async () => {
  let sessions = 0;
  const path = await start(() => { sessions++; });
  const c = new Client(path);
  const hello = JSON.parse(await c.next()) as { nonce: string };
  c.send(JSON.stringify({ hello: 'iecode-bridge', protocol: 1, nonce: 'bm', proof: proof(randomBytes(32).toString('base64'), 'bridge', hello.nonce, 'bm') }));
  await c.whenClosed();
  assert.equal(sessions, 0);
  assert.equal(await Promise.race([c.next(), new Promise(r => setTimeout(() => r('none'), 50))]), 'none');
});

test('servePipe closes on an oversized line', async () => {
  const path = await start(() => { /* never reached */ });
  const c = new Client(path);
  await c.next(); // hello
  c.socket.write('x'.repeat(MAX_FRAME + 10));
  await c.whenClosed();
});

test('servePipe calls onClose when the client disconnects', async () => {
  const closed = new Promise<void>(resolve => {
    void start(conn => conn.onClose(resolve)).then(async path => {
      const c = new Client(path);
      await handshake(c);
      c.end();
    });
  });
  await closed;
});

test('servePipe rejects a second server on the same pipe name', async () => {
  const path = await start(() => { /* unused */ });
  await assert.rejects(servePipe(path, SECRET, () => { /* unused */ }));
});

test('servePipe closes a client that stays silent after connecting', async () => {
  const path = await start(() => { /* never reached */ }, 150);
  const c = new Client(path);
  await c.next(); // hello, then silence
  await c.whenClosed();
});

test('send refuses a line over the limit in bytes', async () => {
  const conn = await new Promise<PipeConnection>(resolve => {
    void start(resolve).then(async path => { const c = new Client(path); await handshake(c); });
  });
  // 600 000 characters, 1 200 000 bytes
  assert.throws(() => conn.send('ä'.repeat(600_000)), FrameTooLong);
  conn.close();
});

test('two sends never interleave', async () => {
  const probe = sessionProbe();
  const path = await start(probe.onSession);
  const c = new Client(path);
  await handshake(c);
  const conn = await probe.connection;
  const a = 'a'.repeat(700_000);
  const b = 'b'.repeat(700_000);
  conn.send(a);
  conn.send(b);
  assert.equal(await c.next(), a);
  assert.equal(await c.next(), b);
  c.end();
});

test('lines that arrive before a handler is registered are delivered to it', async () => {
  const got = await new Promise<string[]>(resolve => {
    void start(conn => {
      setTimeout(() => { const l: string[] = []; conn.onLine(x => { l.push(x); if (l.length === 2) resolve(l); }); }, 50);
    }).then(async path => {
      const c = new Client(path);
      await handshake(c);
      c.send('one');
      c.send('two');
    });
  });
  assert.deepEqual(got, ['one', 'two']);
});
