import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addArgs, removeArgs, getArgs, manualCommand, parseEntry, restoreArgs, cmdLine, findOnPath, isNotRegistered } from '../src/core/claudeRegistration';

// Real output of `claude mcp get` (Claude Code 2.1.318), the spike's fixture with the server renamed
const HEALTHY = `iecode:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: C:\\Users\\me\\AppData\\Local\\iecode\\iecode.exe
  Args: mcp
  Environment:

To remove this server, run: claude mcp remove iecode -s user
`;
const FAILED = HEALTHY.replace('✔ Connected', '✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed');
const WITH_ENV = `other:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: C:\\tools\\srv.js --flag
  Environment:
    TOKEN=abc
    MODE=fast

To remove this server, run: claude mcp remove other -s user
`;
const ABSENT = 'No MCP server named "iecode". Configured servers: claude.ai Claude Docs, spike';
const EXE = 'C:\\Users\\me\\AppData\\Local\\iecode\\iecode.exe';

test('addArgs builds the user-scope stdio registration', () => {
  assert.deepEqual(addArgs(EXE), ['mcp', 'add', '-s', 'user', 'iecode', '--', EXE, 'mcp']);
  assert.deepEqual(removeArgs(), ['mcp', 'remove', '-s', 'user', 'iecode']);
  assert.deepEqual(getArgs(), ['mcp', 'get', 'iecode']);
});

test('parseEntry reads the command of the entry', () => {
  assert.equal(parseEntry(HEALTHY)?.command, EXE);
  assert.equal(parseEntry(FAILED)?.command, EXE);
  assert.equal(parseEntry(ABSENT), undefined);
});

test('absent entries are recognised in both wordings', () => {
  assert.equal(isNotRegistered(ABSENT), true);
  assert.equal(isNotRegistered('No MCP server found with name: iecode'), true);
  assert.equal(isNotRegistered(HEALTHY), false);
});

test('manualCommand quotes the path', () => {
  assert.equal(manualCommand('C:\\Program Files\\iecode\\iecode.exe'), 'claude mcp add -s user iecode -- "C:\\Program Files\\iecode\\iecode.exe" mcp');
  assert.equal(manualCommand(EXE), `claude mcp add -s user iecode -- ${EXE} mcp`);
});

test('cmdLine quotes arguments and refuses metacharacters', () => {
  assert.equal(cmdLine(['mcp', 'add', 'C:\\a b\\x.exe']), 'mcp add "C:\\a b\\x.exe"');
  for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a"b', 'a\nb']) assert.throws(() => cmdLine(['mcp', bad]), /cmd\.exe/, bad);
});

test('findOnPath ignores the current folder and relative entries', () => {
  const present = new Set(['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe', '.\\claude.exe', 'tools\\claude.exe', 'C:\\only\\claude.cmd']);
  const exists = (p: string) => present.has(p);
  assert.deepEqual(findOnPath('.;tools;C:\\bin', exists), { exe: 'C:\\bin\\claude.exe', cmd: 'C:\\bin\\claude.cmd' });
  assert.deepEqual(findOnPath('.;tools', exists), {});
  assert.deepEqual(findOnPath('"C:\\only"', exists), { cmd: 'C:\\only\\claude.cmd' });
  assert.deepEqual(findOnPath('', exists), {});
  assert.deepEqual(findOnPath('C:\\bin', p => p === 'C:\\bin\\iecode.exe', 'iecode'), { exe: 'C:\\bin\\iecode.exe' });
});

test('parseEntry keeps command, args and env of an existing entry', () => {
  const e = parseEntry(WITH_ENV)!;
  assert.equal(e.scope, 'user');
  assert.equal(e.transport, 'stdio');
  assert.equal(e.command, 'node');
  assert.deepEqual(e.args, ['C:\\tools\\srv.js', '--flag']);
  assert.deepEqual(e.env, { TOKEN: 'abc', MODE: 'fast' });
  assert.match(e.raw, /Command: node/);
  assert.deepEqual(parseEntry(HEALTHY)!.args, ['mcp']);
  assert.deepEqual(parseEntry(HEALTHY)!.env, {});
  assert.equal(parseEntry(ABSENT), undefined);
});

test('restoreArgs rebuilds the add command of a saved entry', () => {
  assert.deepEqual(restoreArgs(parseEntry(HEALTHY)!), ['mcp', 'add', '-s', 'user', 'iecode', '--', EXE, 'mcp']);
  assert.deepEqual(restoreArgs({ ...parseEntry(WITH_ENV)!, args: ['C:\\tools\\srv.js'] }), ['mcp', 'add', '-s', 'user', 'iecode', '-e', 'TOKEN=abc', '-e', 'MODE=fast', '--', 'node', 'C:\\tools\\srv.js']);
  // several arguments may really be one with a space inside: not restored by guessing
  assert.equal(restoreArgs(parseEntry(WITH_ENV)!), undefined);
  assert.equal(restoreArgs({ ...parseEntry(HEALTHY)!, transport: 'http' }), undefined);
  assert.equal(restoreArgs({ ...parseEntry(HEALTHY)!, scope: '' }), undefined);
});

test('iecode.cliPath stays machine scoped', () => {
  // a workspace must not be able to choose the executable that gets registered with Claude Code
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['iecode.cliPath'].scope, 'machine');
});
