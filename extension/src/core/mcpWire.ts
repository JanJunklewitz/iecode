// Wire contract between the iecode MCP bridge (CLI) and the extension, extension side. Pure: no VS Code API, no sockets.
// Framing, the mutual HMAC handshake and path canonicalisation; the golden fixture testdata/mcp-wire.json pins the proofs
// so the C# side cannot drift away from this file unnoticed.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_FRAME = 1_048_576;

/** `instances/<id>.json` in the discovery directory. */
export interface InstanceFile {
  format: 1;
  id: string;
  pid: number;
  startedAt: string;
  extensionVersion: string;
  bridgeProtocol: { min: number; max: number };
  /** Pipe name without the `\\.\pipe\` prefix. */
  pipe: string;
  roots: string[];
  workspaceName: string;
  rootsRevision: number;
  /** base64, 32 random bytes; never sent over the pipe. */
  secret: string;
}

export const randomNonce = (): string => randomBytes(16).toString('base64');

/** proof(role) = base64(HMAC-SHA256(secret bytes, "<role>|<extNonce>|<bridgeNonce>")). */
export function proof(secret: string, role: 'bridge' | 'ext', extNonce: string, bridgeNonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(`${role}|${extNonce}|${bridgeNonce}`, 'utf8').digest('base64');
}

/** Constant time; a different length is simply a mismatch. */
export function proofMatches(expected: string, given: string | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class FrameTooLong extends Error {
  constructor() { super('a frame is longer than the limit'); }
}

/** Splits a byte stream into newline-delimited UTF-8 lines; a partial line (and a multibyte character) is kept across chunks. */
export class LineFramer {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly max = MAX_FRAME) {}

  push(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    const lines: string[] = [];
    for (;;) {
      const nl = this.pending.indexOf(0x0a);
      if (nl < 0) break;
      if (nl > this.max) throw new FrameTooLong();
      let end = nl;
      if (end > 0 && this.pending[end - 1] === 0x0d) end--;
      lines.push(this.pending.subarray(0, end).toString('utf8'));
      this.pending = this.pending.subarray(nl + 1);
    }
    if (this.pending.length > this.max) throw new FrameTooLong();
    return lines;
  }
}

/** The extension's half of the handshake: line 1 out, line 2 in, line 3 out. */
export class ExtHandshake {
  private state: 'waiting' | 'done' | 'failed' = 'waiting';

  constructor(private readonly secret: string, private readonly nonce: string = randomNonce()) {}

  first(): string {
    return JSON.stringify({ hello: 'iecode-ext', nonce: this.nonce });
  }

  /** Consumes the bridge's line; `reply` is line 3. A wrong proof or a malformed line fails without a reply. */
  onLine(line: string): { reply?: string; done?: true; fail?: true } {
    if (this.state !== 'waiting') return { fail: true };
    let msg: { hello?: unknown; protocol?: unknown; nonce?: unknown; proof?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return this.fail();
    }
    if (!msg || typeof msg !== 'object' || msg.hello !== 'iecode-bridge' || typeof msg.protocol !== 'number'
      || typeof msg.nonce !== 'string' || typeof msg.proof !== 'string') return this.fail();
    if (!proofMatches(proof(this.secret, 'bridge', this.nonce, msg.nonce), msg.proof)) return this.fail();
    this.state = 'done';
    return { reply: JSON.stringify({ ok: true, proof: proof(this.secret, 'ext', this.nonce, msg.nonce) }), done: true };
  }

  private fail(): { fail: true } {
    this.state = 'failed';
    return { fail: true };
  }
}

/** realpath, backslashes, lower-case drive letter, no trailing separator (a drive root keeps its one). */
export function canonicalRoot(p: string, realpath: (p: string) => string): string {
  let resolved = p;
  try {
    resolved = realpath(p);
  } catch { /* a missing folder keeps its given spelling */ }
  let s = resolved.replace(/\//g, '\\');
  s = s.replace(/^[A-Za-z]:/, m => m.toLowerCase());
  while (s.length > 1 && s.endsWith('\\') && !/^[a-z]:\\$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** `tools.json`: the `tools/list` result, so the bridge can answer from it while no window is open. */
export function toolsFile(tools: { name: string; description: string; inputSchema: object }[]): string {
  return JSON.stringify({ tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }, null, 2) + '\n';
}
