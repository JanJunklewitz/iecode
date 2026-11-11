import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LM_TOOL_NAMES, lmToolEntries } from '../src/core/lmToolTable';

test('the registration table names exactly the tools the manifest declares', () => {
  // out/test/*.js -> the extension's package.json is two levels up
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const declared: string[] = manifest.contributes.languageModelTools.map((t: { name: string }) => t.name);
  assert.deepEqual([...LM_TOOL_NAMES].sort(), [...declared].sort());
});

test('lmToolEntries pairs every name with its handler in declaration order', () => {
  const table = Object.fromEntries(LM_TOOL_NAMES.map(n => [n, `h:${n}`])) as Record<(typeof LM_TOOL_NAMES)[number], string>;
  assert.deepEqual(lmToolEntries(table), LM_TOOL_NAMES.map(n => [n, `h:${n}`]));
});
