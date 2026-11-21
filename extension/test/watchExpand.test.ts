import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAdds } from '../src/core/watchExpand';
import { notSingleValueHint, readStructRows, structNeedsNewerCli, watchListText } from '../src/core/adsToolText';

const m = (name: string, type: string, value: string | null, error: string | null = null) => ({ name, type, value, error });

test('expandAdds replaces a structure by its readable members and keeps other names', () => {
  const r = expandAdds(['MAIN.stAxis', 'MAIN.nCount'], [
    { symbol: 'MAIN.stAxis', error: null, members: [m('MAIN.stAxis.nPos', 'DINT', '1'), m('MAIN.stAxis.bOn', 'BOOL', null, 'x')] },
    { symbol: 'MAIN.nCount', error: null },
  ]);
  assert.deepEqual(r.names, ['MAIN.stAxis.nPos', 'MAIN.nCount']);
  assert.deepEqual(r.lines, ['Expanded MAIN.stAxis into 1 watched member.', 'Not added (read error): MAIN.stAxis.bOn']);
});

test('expandAdds says when members were left out and keeps a name that has an error', () => {
  const r = expandAdds(['MAIN.st', 'MAIN.gone'], [
    { symbol: 'MAIN.st', error: null, members: [m('MAIN.st.a', 'INT', '1')], notes: { omittedMembers: 4800, omittedElements: 0, notExpanded: [] } },
    { symbol: 'MAIN.gone', error: 'Symbol not found' },
  ]);
  assert.deepEqual(r.names, ['MAIN.st.a', 'MAIN.gone']);
  assert.ok(r.lines.includes('MAIN.st: 4800 more members not added (the limit is 200).'));
});

test('expandAdds lists a name once, compared without case', () => {
  const r = expandAdds(['MAIN.st', 'main.st.a'], [{ symbol: 'MAIN.st', error: null, members: [m('MAIN.st.a', 'INT', '1')] }]);
  assert.deepEqual(r.names, ['MAIN.st.a']);
});

test('readStructRows: header, members, member errors and every note', () => {
  const text = readStructRows({
    symbol: 'MAIN.stAxis', type: 'ST_Axis',
    members: [m('MAIN.stAxis.nPos', 'DINT', '120'), m('MAIN.stAxis.bOn', 'BOOL', null, 'DeviceSymbolNotFound (0x710)'), m('MAIN.stAxis.x', 'INT', '1')],
    notes: { omittedMembers: 4800, omittedElements: 35, notExpanded: ['MAIN.stAxis.pNext (pointer or reference)', 'MAIN.stAxis.stDeep (depth limit)'] },
  });
  assert.equal(text, [
    'MAIN.stAxis : ST_Axis (3 members)',
    '  MAIN.stAxis.nPos : DINT = 120',
    '  MAIN.stAxis.bOn : error DeviceSymbolNotFound (0x710)',
    '  MAIN.stAxis.x : INT = 1',
    '  (4800 members left out: at most 200 are read; read a part of the structure for the rest)',
    '  (35 array elements left out: at most 20 per array are read)',
    '  (not expanded: MAIN.stAxis.pNext (pointer or reference), MAIN.stAxis.stDeep (depth limit))',
  ].join('\n'));
  assert.equal(readStructRows({ symbol: 'A', type: 'T', members: [m('A.x', 'INT', '1')] }).split('\n')[0], 'A : T (1 member)');
});

test('structNeedsNewerCli and notSingleValueHint', () => {
  assert.equal(structNeedsNewerCli('MAIN.stAxis'), 'MAIN.stAxis : error is not a single value; struct expansion needs a newer iecode CLI: structRead');
  assert.equal(notSingleValueHint('ST_Axis is not a single value; add its members instead'), 'ST_Axis is not a single value; add its members instead, or add it with expand: true');
  assert.equal(notSingleValueHint('Symbol not found'), 'Symbol not found');
  assert.equal(notSingleValueHint(null), null);
  const list = watchListText([{ symbol: 'MAIN.st', type: 'ST_Axis', numeric: false, error: 'ST_Axis is not a single value; add its members instead' }], []);
  assert.match(list, /or add it with expand: true/);
});
