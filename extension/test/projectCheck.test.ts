import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeElement } from '../src/core/plcproj';
import {
  DiskTree, Issue, applyFix, checkProject, describeResolve, fixesFor, listEntries, minimalEdit, resolveProject, scanProjectDir,
} from '../src/core/projectCheck';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures');
const brokenDir = join(fixtures, 'plcproj-broken', 'PLC');
const broken = () => readFileSync(join(brokenDir, 'PLC.plcproj'), 'utf8');
const resolved = () => readFileSync(join(fixtures, 'plcproj-broken', 'PLC.plcproj.resolved'), 'utf8');
const plc1Dir = join(fixtures, 'ws', 'apps/MachineX/MachineX/PLC1');

const summary = (text: string, issues: Issue[]) => issues.map(i => `${i.code} ${i.severity} ${text.slice(i.start, i.end)}`);

test('scans the project folder, skipping output, hidden and nested project folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-check-'));
  try {
    cpSync(brokenDir, dir, { recursive: true });
    for (const d of ['_CompileInfo', '.vs', 'Nested']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, '_CompileInfo', 'X.TcPOU'), '');
    writeFileSync(join(dir, '.vs', 'X.TcPOU'), '');
    writeFileSync(join(dir, 'Nested', 'Nested.plcproj'), '');
    writeFileSync(join(dir, 'Nested', 'FB_Other.TcPOU'), '');
    const disk = await scanProjectDir(dir);
    assert.deepEqual(disk.folders, ['DUTs', 'Docs', 'GVLs', 'POUs', 'POUs/New']);
    assert.ok(disk.files.includes('POUs/New/FB_Unlisted.TcPOU'));
    assert.ok(!disk.files.some(f => /_CompileInfo|\.vs|Nested/.test(f)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lists Compile, None and Folder entries with the offsets of their paths', () => {
  const text = broken();
  const entries = listEntries(text);
  assert.equal(entries.length, 16);
  const folder = entries.find(e => e.kind === 'Folder' && e.trailingSlash)!;
  assert.equal(folder.rel, 'POUs');
  assert.equal(text.slice(folder.valueStart, folder.valueEnd), 'POUs\\');
  assert.equal(text.slice(folder.start, folder.end), '<Folder Include="POUs\\" />');
});

test('reports missing files and folders, duplicates, case differences and unlisted object files', async () => {
  const text = broken();
  const issues = checkProject(text, await scanProjectDir(brokenDir));
  assert.deepEqual(summary(text, issues), [
    'duplicate warning duts\\e_state.TcDUT',
    'missing-file error GVLs\\Old\\GVL_Moved.TcGVL',
    'missing-file error POUs\\FB_Gone.TcPOU',
    'case-mismatch warning POUs\\fb_listed.TcPOU',
    'duplicate warning POUs\\MAIN.TcPOU',
    'missing-folder warning GVLs\\Old',
    'duplicate warning POUs\\',
    'missing-folder warning Removed',
    'missing-file warning Docs\\gone.txt',
    // at the <ItemGroup> of the Compile entries: nothing in the file names it
    'unlisted warning <ItemGroup>',
  ]);
  const moved = issues.find(i => i.rel === 'GVLs/Old/GVL_Moved.TcGVL')!;
  assert.equal(moved.actual, 'GVLs/GVL_Moved.TcGVL', 'a missing file found elsewhere under its name counts as moved');
  assert.match(moved.message, /moved to GVLs\\GVL_Moved\.TcGVL/);
  assert.ok(!issues.some(i => i.code === 'unlisted' && i.rel === 'GVLs/GVL_Moved.TcGVL'), 'the moved file is not also unlisted');
  assert.equal(issues.find(i => i.code === 'case-mismatch')!.actual, 'POUs/FB_Listed.TcPOU');
  assert.match(issues.find(i => i.code === 'duplicate' && i.rel === 'POUs/MAIN.TcPOU')!.message, /line 25/);
});

test('a clean project has no issues and Resolve leaves it byte-identical', async () => {
  const text = readFileSync(join(plc1Dir, 'PLC1.plcproj'), 'utf8');
  const disk = await scanProjectDir(plc1Dir);
  assert.deepEqual(checkProject(text, disk), []);
  const r = resolveProject(text, disk);
  assert.equal(r.text, text);
  assert.deepEqual(describeResolve(r), []);
});

test('Resolve repairs the whole file minimally, keeping BOM, CRLF, order and SubType', async () => {
  const text = broken();
  const disk = await scanProjectDir(brokenDir);
  const r = resolveProject(text, disk);
  assert.equal(r.text, resolved());
  assert.ok(r.text.startsWith('﻿<?xml'), 'BOM kept');
  assert.ok(!/[^\r]\n/.test(r.text), 'CRLF only');
  assert.deepEqual(describeResolve(r), [
    'Remove duplicate Compile duts\\e_state.TcDUT',
    'Remove Compile POUs\\FB_Gone.TcPOU (not found)',
    'Remove duplicate Compile POUs\\MAIN.TcPOU',
    'Remove Folder GVLs\\Old (not found)',
    'Remove duplicate Folder POUs',
    'Remove Folder Removed (not found)',
    'Remove None Docs\\gone.txt (not found)',
    'Move GVLs\\Old\\GVL_Moved.TcGVL → GVLs\\GVL_Moved.TcGVL',
    'Fix case of POUs\\fb_listed.TcPOU → POUs\\FB_Listed.TcPOU',
    'Add Folder POUs\\New',
    'Add Compile POUs\\New\\FB_Unlisted.TcPOU',
  ]);
  // round trip: nothing left to fix, and a second run changes nothing
  assert.deepEqual(checkProject(r.text, disk), []);
  assert.equal(resolveProject(r.text, disk).text, r.text);
  // every line of the result was already in the file, except the added entries
  const before = new Set(text.split('\r\n'));
  assert.deepEqual(r.text.split('\r\n').filter(l => !before.has(l)), [
    '    <Compile Include="GVLs\\GVL_Moved.TcGVL">',
    '    <Compile Include="POUs\\FB_Listed.TcPOU">',
    '    <Compile Include="POUs\\New\\FB_Unlisted.TcPOU">',
    '    <Folder Include="POUs\\New" />',
  ]);
});

test('Resolve keeps LF line endings and files without BOM', () => {
  const text = [
    '<Project>', '  <ItemGroup>', '    <Compile Include="A.TcPOU" />', '    <Compile Include="Gone.TcPOU" />', '  </ItemGroup>', '</Project>', '',
  ].join('\n');
  const disk: DiskTree = { files: ['A.TcPOU', 'Sub/B.TcDUT'], folders: ['Sub'] };
  const r = resolveProject(text, disk);
  assert.equal(r.text, [
    '<Project>', '  <ItemGroup>', '    <Compile Include="A.TcPOU" />', '    <Compile Include="Sub\\B.TcDUT">', '      <SubType>Code</SubType>', '    </Compile>', '  </ItemGroup>',
    '  <ItemGroup>', '    <Folder Include="Sub" />', '  </ItemGroup>', '</Project>', '',
  ].join('\n'));
});

test('paths that are not judged: output folders, outside the project, wildcards', () => {
  const text = '<Project><ItemGroup><Compile Include="_Libraries\\X.TcPOU" /><Compile Include="..\\Shared\\Y.TcPOU" /><None Include="*.txt" /></ItemGroup></Project>';
  assert.deepEqual(checkProject(text, { files: [], folders: [] }), []);
});

test('no move guess when the name is ambiguous', () => {
  const text = '<Project><ItemGroup><Compile Include="Old\\FB_A.TcPOU" /></ItemGroup></Project>';
  const issues = checkProject(text, { files: ['X/FB_A.TcPOU', 'Y/FB_A.TcPOU'], folders: ['X', 'Y'] });
  assert.deepEqual(issues.map(i => `${i.code}:${i.rel}:${i.actual ?? ''}`), ['missing-file:Old/FB_A.TcPOU:', 'unlisted:X/FB_A.TcPOU:', 'unlisted:Y/FB_A.TcPOU:']);
});

test('every quick fix removes its issue and nothing else', async () => {
  const text = broken();
  const disk = await scanProjectDir(brokenDir);
  const issues = checkProject(text, disk);
  for (const issue of issues) {
    assert.ok(fixesFor(issue).length, issue.code);
    for (const fix of fixesFor(issue)) {
      const out = applyFix(text, issue, fix);
      const left = checkProject(out, disk);
      // removing the entry of a moved file leaves the file unlisted
      const unlisted = fix === 'remove' && issue.actual ? 1 : 0;
      assert.equal(left.length, issues.length - 1 + unlisted, `${issue.code} ${issue.rel} ${fix}`);
    }
  }
  // the duplicate fix removes the second entry, not the first
  const dup = issues.find(i => i.code === 'duplicate' && i.rel === 'POUs/MAIN.TcPOU')!;
  const out = applyFix(text, dup, 'remove');
  assert.equal(out.indexOf('POUs\\MAIN.TcPOU'), text.indexOf('POUs\\MAIN.TcPOU'));
  // adding an unlisted file also adds its folder
  const add = applyFix(text, issues.find(i => i.code === 'unlisted')!, 'add');
  assert.match(add, /<Folder Include="POUs\\New" \/>\r\n/);
  assert.match(add, /<Compile Include="POUs\\New\\FB_Unlisted.TcPOU">\r\n      <SubType>Code<\/SubType>\r\n    <\/Compile>/);
});

test('removes an element with its line, or only the element when it shares the line', () => {
  const text = 'a\r\n  <X />\r\nb';
  assert.equal(removeElement(text, text.indexOf('<X'), text.indexOf('/>') + 2), 'a\r\nb');
  const inline = 'a<X /><Y />b';
  assert.equal(removeElement(inline, 1, 6), 'a<Y />b');
});

test('minimal edit between two texts', () => {
  assert.deepEqual(minimalEdit('abcdef', 'abXYef'), { start: 2, end: 4, text: 'XY' });
  assert.deepEqual(minimalEdit('aaa', 'aaaa'), { start: 3, end: 3, text: 'a' });
  assert.deepEqual(minimalEdit('same', 'same'), { start: 4, end: 4, text: '' });
  const before = broken(), after = resolved();
  const e = minimalEdit(before, after);
  assert.equal(before.slice(0, e.start) + e.text + before.slice(e.end), after);
});
