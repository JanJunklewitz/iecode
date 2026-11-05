// The extension's named-pipe listener for the MCP bridge. Free of the VS Code API, so it runs under node --test.
// Every connection runs the handshake first; `onSession` fires only for a client that proved it knows the secret.

import * as fs from 'node:fs';
import * as net from 'node:net';
import { ExtHandshake, FrameTooLong, LineFramer, MAX_FRAME } from './mcpWire';

export interface PipeConnection {
  /** Throws FrameTooLong when the UTF-8 length of `line` exceeds MAX_FRAME; one write per line, so sends never interleave. */
  send(line: string): void;
  /** Lines that arrive before the first handler is registered are kept and delivered to it. */
  onLine(fn: (line: string) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

export interface PipeServer {
  close(): Promise<void>;
}

export interface PipeOptions {
  /** A client that does not finish the handshake in this time is dropped (default 5 s), so probes do not pile up. */
  handshakeMs?: number;
}

class Connection implements PipeConnection {
  private readonly lineHandlers: ((line: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private queued: string[] = [];
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('close', () => {
      this.closed = true;
      for (const fn of this.closeHandlers) fn();
    });
  }

  send(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) throw new FrameTooLong();
    if (this.closed) return;
    this.socket.write(line + '\n');
  }

  onLine(fn: (line: string) => void): void {
    this.lineHandlers.push(fn);
    const queued = this.queued;
    this.queued = [];
    for (const l of queued) fn(l);
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  close(): void {
    this.socket.destroy();
  }

  deliver(line: string): void {
    if (this.lineHandlers.length === 0) this.queued.push(line);
    else for (const fn of this.lineHandlers) fn(line);
  }
}

/**
 * Whether a pipe exists, by the pipe directory listing: it does not open the pipe, so it uses up none of the server's instances
 * (a window paused in a debugger has few). A listing that fails counts as "exists": unknown is not gone, so the sweep of stale
 * instance files never erases the file of a window that merely does not answer.
 */
export function pipeExists(pipePath: string, list: () => string[] = () => fs.readdirSync('\\\\.\\pipe\\')): boolean {
  const name = pipePath.replace(/^\\\\\.\\pipe\\/i, '').toLowerCase();
  try {
    return list().some(n => n.toLowerCase() === name);
  } catch {
    return true;
  }
}

export function servePipe(pipePath: string, secret: string, onSession: (c: PipeConnection) => void, options: PipeOptions = {}): Promise<PipeServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    const framer = new LineFramer();
    const handshake = new ExtHandshake(secret);
    let connection: Connection | undefined;
    const timer = setTimeout(() => { if (!connection) socket.destroy(); }, options.handshakeMs ?? 5000);
    socket.on('close', () => clearTimeout(timer));
    socket.write(handshake.first() + '\n');

    socket.on('data', chunk => {
      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        if (socket.destroyed) return;
        if (connection) {
          connection.deliver(line);
          continue;
        }
        const step = handshake.onLine(line);
        if (step.fail) {
          socket.destroy();
          return;
        }
        if (step.reply) socket.write(step.reply + '\n');
        if (step.done) {
          clearTimeout(timer);
          connection = new Connection(socket);
          onSession(connection);
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.removeListener('error', reject);
      server.on('error', () => { /* a failing accept must not crash the host */ });
      resolve({
        close: () => new Promise<void>(done => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
