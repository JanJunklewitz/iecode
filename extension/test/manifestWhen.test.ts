import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Every `when` string of the manifest, wherever it sits (menus, keybindings, welcome views, ...). */
function whens(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach(n => whens(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'when' && typeof v === 'string') out.push(v);
      else whens(v, out);
    }
  }
  return out;
}

test('a regex in a when clause is not escaped twice: it must reach RegExp as \\. and not as \\\\.', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const all = whens(pkg.contributes);
  assert.ok(all.length > 20, 'the manifest has when clauses');
  for (const w of all) {
    for (const m of w.matchAll(/=~\s*\/(.*?)\/([a-z]*)(?:\s|$)/g)) {
      assert.ok(!m[1].includes('\\\\'), `${w}: the regex has two backslashes in a row, so it would require a literal backslash`);
      assert.doesNotThrow(() => new RegExp(m[1], m[2]), w);
      // every clause that lists the object extensions must match them in any case, as TwinCAT files are found as .TcPOU and .TCPOU
      if (/TcPOU/.test(m[1])) {
        const re = new RegExp(m[1], m[2]);
        assert.ok(re.test('Main.TcPOU') && re.test('MAIN.TCPOU') && !re.test('Main.txt'), `${w}: must match .TcPOU and .TCPOU but not .txt`);
      }
    }
  }
  // the clause that matters most: object files in the explorer
  const explorer = all.find(w => /TcPOU\|TcDUT/.test(w) && /resourceExtname/.test(w))!;
  const re = new RegExp(/=~\s*\/(.*?)\/i/.exec(explorer)![1], 'i');
  assert.ok(re.test('.TcPOU') && re.test('.tcdut') && !re.test('.txt'));
});
