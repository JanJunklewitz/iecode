// The `claude mcp` command lines that register or remove the IECode MCP bridge, and the parsing of `claude mcp get`.
// Pure: no process is started here, so every rule (quoting, PATH lookup, restoring an entry) is unit-tested.

import * as path from 'node:path';

const win = path.win32;

export const SERVER_NAME = 'iecode';

export const addArgs = (exe: string): string[] => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', exe, 'mcp'];
export const removeArgs = (): string[] => ['mcp', 'remove', '-s', 'user', SERVER_NAME];
export const getArgs = (): string[] => ['mcp', 'get', SERVER_NAME];

const quote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The add command as one line for the clipboard (a user who has no `claude` on PATH runs it by hand). */
export const manualCommand = (exe: string): string => ['claude', ...addArgs(exe)].map(quote).join(' ');

/** `claude mcp get` of a server that is not there: the wording differs between Claude Code versions. */
export const isNotRegistered = (getOutput: string): boolean => /No MCP server (named|found)/i.test(getOutput);

export interface RegisteredEntry {
  scope: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  raw: string;
}

const SCOPES: [RegExp, string][] = [[/^user\b/i, 'user'], [/^project\b/i, 'project'], [/^local\b/i, 'local']];

/** The whole entry of `claude mcp get <name>` (scope, transport, command, args, env), or undefined when it is not a stdio-style listing. */
export function parseEntry(getOutput: string): RegisteredEntry | undefined {
  const value = (label: string): string | undefined => new RegExp(`^\\s*${label}:[ \\t]*(.*)$`, 'mi').exec(getOutput)?.[1].trim();
  const transport = value('Type');
  const command = value('Command');
  if (!transport || !command) return undefined;
  const scopeText = value('Scope') ?? '';
  const scope = SCOPES.find(([re]) => re.test(scopeText))?.[1] ?? '';
  const argText = value('Args') ?? '';
  const env: Record<string, string> = {};
  const envBlock = /^\s*Environment:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)*)/im.exec(getOutput)?.[1] ?? '';
  for (const line of envBlock.split(/\r?\n/)) {
    const m = /^\s+([^=\s]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return { scope, transport, command, args: argText ? argText.split(/\s+/) : [], env, raw: getOutput.trim() };
}

/**
 * The `claude mcp add` arguments that recreate a saved entry; undefined when they cannot be expressed (not stdio, unknown scope, or
 * several arguments: `claude mcp get` joins them with spaces, so one with a space inside cannot be told from two).
 */
export function restoreArgs(e: RegisteredEntry): string[] | undefined {
  if (e.transport.toLowerCase() !== 'stdio' || !e.scope || e.args.length > 1) return undefined;
  const env = Object.entries(e.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', '-s', e.scope, SERVER_NAME, ...env, '--', e.command, ...e.args];
}

/** One cmd.exe line for `claude.cmd`; refuses what cmd.exe would interpret (R1): a path is data, never a command. */
export function cmdLine(args: string[]): string {
  return args.map(a => {
    if (/[&|<>^%!"\r\n]/.test(a)) throw new Error(`argument contains a character cmd.exe would interpret: ${a}`);
    return /\s/.test(a) ? `"${a}"` : a;
  }).join(' ');
}

/** A program on PATH by absolute entries only (R12): the current folder and relative entries are never searched. `.exe` wins over `.cmd`. */
export function findOnPath(pathEnv: string, exists: (p: string) => boolean, base = 'claude'): { exe?: string; cmd?: string } {
  const found: { exe?: string; cmd?: string } = {};
  for (const raw of pathEnv.split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !win.isAbsolute(dir)) continue;
    const exe = win.join(dir, `${base}.exe`);
    const cmd = win.join(dir, `${base}.cmd`);
    if (!found.exe && exists(exe)) found.exe = exe;
    if (!found.cmd && exists(cmd)) found.cmd = cmd;
    if (found.exe) break;
  }
  return found;
}
