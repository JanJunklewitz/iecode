import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ImagePool, TextList, VisuManager, applyArchiveEdits, parsePlcArchive, plcArchiveToText, summaryText } from '../src/core/plcArchive';
import { VisuEditError } from '../src/core/tcvis';

const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'archive');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const gtlo = read('GlobalTextList.TcGTLO'), ipo = read('ImagePool.TcIPO'), vmo = read('Visualization Manager.TcVMO');

test('text list: ids, defaults, translations by language', () => {
  const t = parsePlcArchive(gtlo) as TextList;
  assert.equal(t.kind, 'textlist');
  assert.deepEqual(t.languages, ['de', 'fr']);
  assert.deepEqual(t.rows.map(r => [r.id, r.text]), [['101', 'Start'], ['102', 'Motor & pump']]);
  assert.deepEqual(t.rows[0].translations.map(x => x?.value), ['Starten', 'Démarrer']);
  assert.equal(t.rows[1].translations[1], undefined, 'null translation: not editable here');
});

test('image pool: ids and files relative to the PLC project', () => {
  const p = parsePlcArchive(ipo) as ImagePool;
  assert.deepEqual(p.items.map(i => [i.id, i.itemId, i.path]), [['Pump', 6, 'Images/Pump.png'], ['', 7, '']]);
});

test('visualization manager: every stored value by path', () => {
  const v = parsePlcArchive(vmo) as VisuManager;
  const get = (p: string) => v.settings.find(s => s.path === p);
  assert.equal(get('ViewSettings.StartVisu33')?.value, 'VI_Main');
  assert.equal(get('ViewSettings.ClientSizeX')?.kind, 'number');
  assert.equal(get('ViewSettings.ClientSizeMode')?.kind, 'name');
  assert.equal(get('VisuUserManagement.ApplyLoginRestrictions')?.kind, 'bool');
  assert.equal(get('ViewSettings.StartVisu'), undefined, 'null values are not listed');
});

test('YAML summaries for diffs', () => {
  assert.equal(plcArchiveToText(parsePlcArchive(gtlo)),
    '# Text list GlobalTextList (2 texts)\nname: GlobalTextList\nlanguages: [de, fr]\ntexts:\n' +
    '  - "101": Start\n    de: Starten\n    fr: "Démarrer"\n  - "102": "Motor & pump"\n    de: "Motor & Pumpe"\n');
  assert.match(summaryText(ipo), /^ {2}- Pump: Images\/Pump\.png$/m);
  const vm = summaryText(vmo);
  assert.match(vm, /^ {2}ViewSettings\.ClientSizeX: "1920"$/m);
  assert.ok(!/0000-0000-000000000000/.test(vm), 'ids left out');
  assert.match(summaryText(readFileSync(join(dir, '..', 'visu', 'VI_Demo.TcVIS'), 'utf8')), /^name: VI_Demo$/m);
});

test('edits splice single values, round trip byte-identical', () => {
  const v = parsePlcArchive(vmo) as VisuManager;
  const s = (p: string) => v.settings.find(x => x.path === p)!;
  const edits = [
    { at: s('ViewSettings.StartVisu33').at, old: s('ViewSettings.StartVisu33').raw, value: 'VI_Overview' },
    { at: s('ViewSettings.ClientSizeX').at, old: s('ViewSettings.ClientSizeX').raw, value: '1280' },
    { at: s('VisuUserManagement.ApplyLoginRestrictions').at, old: 'false', value: 'true' },
  ];
  const out = applyArchiveEdits(vmo, edits);
  assert.ok(out.includes('<v n="StartVisu33">"VI_Overview"</v>\r\n') && out.includes('<v n="ClientSizeX">1280</v>'));
  const w = parsePlcArchive(out) as VisuManager;
  assert.equal(w.settings.find(x => x.path === 'VisuUserManagement.ApplyLoginRestrictions')!.value, 'true');
  const back = w.settings.filter(x => edits.some(e => x.path === v.settings.find(y => y.at === e.at)!.path));
  assert.equal(applyArchiveEdits(out, back.map(x => ({ at: x.at, old: x.raw, value: v.settings.find(y => y.path === x.path)!.value }))), vmo);

  const t = parsePlcArchive(gtlo) as TextList;
  const fr = t.rows[0].translations[1]!;
  const tr = applyArchiveEdits(gtlo, [{ at: fr.at, old: fr.raw, value: 'Lancer <ici> & là' }]);
  assert.equal((parsePlcArchive(tr) as TextList).rows[0].translations[1]!.value, 'Lancer <ici> & là');
});

test('refuses stale or id edits', () => {
  const v = parsePlcArchive(vmo) as VisuManager;
  const x = v.settings.find(s => s.path === 'ViewSettings.ClientSizeX')!;
  assert.throws(() => applyArchiveEdits(vmo, [{ at: x.at, old: '1280', value: '1' }]), VisuEditError);
  const g = v.settings.find(s => s.kind === 'guid')!;
  assert.throws(() => applyArchiveEdits(vmo, [{ at: g.at, old: g.raw, value: 'x' }]), /ids/);
  assert.throws(() => parsePlcArchive('<TcPlcObject><POU/></TcPlcObject>'), /not a TwinCAT text list/);
});
