import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigEntry, cycleTimeText, flattenConfig } from '../src/core/configmodel';
import { ConfigChange, DEFAULT_HIDDEN, configToYaml, diffConfig, groupChanges } from '../src/core/configdiff';

const LIC = '{22222222-0000-0000-0000-000000000001}';

export const PLC_XTI = `<?xml version="1.0"?>
<TcSmItem TcVersion="3.1.4024.12">
  <DataTypes>
    <DataType>
      <Name GUID="{11111111-0000-0000-0000-000000000001}" Namespace="">ST_Motor</Name>
      <BitSize>32</BitSize>
      <SubItem>
        <Name>nSpeed</Name>
        <Type GUID="{11111111-0000-0000-0000-000000000002}">INT</Type>
        <BitOffs>0</BitOffs>
      </SubItem>
      <SubItem>
        <Name>bRun</Name>
        <Type GUID="{11111111-0000-0000-0000-000000000003}">BOOL</Type>
        <BitOffs>16</BitOffs>
      </SubItem>
    </DataType>
    <DataType>
      <Name GUID="{11111111-0000-0000-0000-000000000004}" Namespace="">E_Mode</Name>
      <BaseType GUID="{11111111-0000-0000-0000-000000000005}">INT</BaseType>
      <EnumInfo><Text>Off</Text><Enum>0</Enum></EnumInfo>
      <EnumInfo><Text>On</Text><Enum>1</Enum></EnumInfo>
      <Properties>
        <Property><Name>to_string_function</Name><Value>__TO_STRING__17</Value></Property>
      </Properties>
    </DataType>
  </DataTypes>
  <Project AmsPort="851">
    <Instance TmcHash="{33333333-0000-0000-0000-000000000001}" LastKnownRefactorCnt="3">
      <Name>Plc</Name>
      <CLSID>{44444444-0000-0000-0000-000000000001}</CLSID>
      <TmcDesc>
        <Licenses>
          <License><LicenseId>${LIC}</LicenseId></License>
          <License><LicenseId>${LIC}</LicenseId></License>
        </Licenses>
        <Contexts>
          <Context>
            <Id>1</Id>
            <Name>PlcTask</Name>
            <ManualConfig><OTCID>#x02010030</OTCID></ManualConfig>
            <Priority>20</Priority>
            <CycleTime>100000</CycleTime>
          </Context>
        </Contexts>
        <ParameterValues>
          <Value><Name>Application Timestamp</Name><Value>2026-01-01 10:00:00</Value></Value>
          <Value><Name>Application Port</Name><Value>851</Value></Value>
        </ParameterValues>
        <Properties>
          <Property><Name>ChangeDate</Name><Value>2026-01-01</Value></Property>
        </Properties>
        <DataAreas>
          <DataArea AreaType="InputDst">
            <Name>PlcTask Inputs</Name>
            <ContextId>1</ContextId>
            <ByteSize>2</ByteSize>
            <Symbol>
              <Name>MAIN.bStart</Name>
              <Comment><![CDATA[Start button]]></Comment>
              <BitSize>1</BitSize>
              <BaseType>BOOL</BaseType>
              <BitOffs>0</BitOffs>
            </Symbol>
          </DataArea>
        </DataAreas>
      </TmcDesc>
      <UnrestoredVarLinks ImportTime="2026-01-01T10:00:00">
        <OwnerA Name="Plc">
          <OwnerB Name="Box 1">
            <Link VarA="Inputs^bIn" VarB="MAIN.bStart" RestoreInfo="ANotFound" GuidA="{55555555-0000-0000-0000-000000000001}"/>
          </OwnerB>
        </OwnerA>
      </UnrestoredVarLinks>
    </Instance>
  </Project>
  <Mappings>
    <OwnerA Name="Plc">
      <OwnerB Name="Term 1">
        <Link VarA="Inputs^bStart" VarB="Channel 1^Input"/>
      </OwnerB>
    </OwnerA>
  </Mappings>
</TcSmItem>
`;

const SPLIT_POINTER = `<?xml version="1.0"?>
<TcSmItem TcVersion="3.1.4024.12">
  <Project AmsPort="851">
    <Instance File="Plc Instance.xti"/>
  </Project>
</TcSmItem>
`;

const SPLIT_INSTANCE = `<?xml version="1.0"?>
<TcSmItem TcVersion="3.1.4024.12">
  <DataTypes>
    <DataType><Name Namespace="">ST_Motor</Name><BitSize>16</BitSize></DataType>
  </DataTypes>
  <Instance>
    <TmcDesc>
      <Contexts><Context><Id>1</Id><Name>PlcTask</Name><Priority>20</Priority></Context></Contexts>
    </TmcDesc>
  </Instance>
</TcSmItem>
`;

const ETHERCAT_XTI = `<?xml version="1.0"?>
<TcSmItem>
  <Device>
    <Name>Device 1</Name>
    <Box><Name>Term 1</Name><EtherCAT SlaveType="1"/></Box>
  </Device>
  <Mappings><OwnerA Name="Device 1"><OwnerB Name="Term 1"><Link VarA="a" VarB="b"/></OwnerB></OwnerA></Mappings>
</TcSmItem>
`;

const byKey = (es: ConfigEntry[]) => new Map(es.map(e => [e.key, e]));

test('flattenConfig finds tasks, licenses, parameters, symbols and types', () => {
  const m = byKey(flattenConfig(PLC_XTI));
  assert.equal(m.get('tasks/PlcTask/CycleTime')?.value, '10 ms');
  assert.equal(m.get('tasks/PlcTask/CycleTime')?.category, 'tasks');
  assert.equal(m.get(`licenses/${LIC}`)?.category, 'licenses');
  assert.ok(m.has(`licenses/${LIC}#2`));
  assert.equal(m.get('parameter-values/Application Port')?.value, '851');
  assert.equal(m.get('parameter-values/Application Port')?.category, 'parameters');
  assert.equal(m.get('symbols/PlcTask Inputs/MAIN.bStart/BaseType')?.value, 'BOOL');
  assert.equal(m.get('symbols/PlcTask Inputs/MAIN.bStart/BaseType')?.category, 'symbols');
  assert.equal(m.get('symbols/PlcTask Inputs/MAIN.bStart/Comment')?.value, 'Start button');
  assert.equal(m.get('types/ST_Motor/SubItem/nSpeed/Type')?.value, 'INT');
  assert.equal(m.get('types/ST_Motor/SubItem/nSpeed/Type')?.category, 'types');
  assert.equal(m.get('types/E_Mode/EnumInfo/On')?.value, '1');
  assert.equal(m.get('project/@AmsPort')?.category, 'settings');
  assert.equal(m.get('TcVersion')?.category, 'settings');
});

test('flattenConfig marks noise', () => {
  const m = byKey(flattenConfig(PLC_XTI));
  assert.equal(m.get('parameter-values/Application Timestamp')?.noise, 'build');
  assert.equal(m.get('properties/ChangeDate')?.noise, 'build');
  assert.equal(m.get('types/E_Mode/Properties/to_string_function')?.noise, 'build');
  assert.equal(m.get('types/ST_Motor/@GUID')?.noise, 'guid');
  assert.equal(m.get('unrestored/@ImportTime#1')?.noise, 'timestamps');
  assert.equal(m.get('unrestored/Plc/Box 1/Inputs^bIn/@GuidA')?.noise, 'guid');
  assert.equal(m.get('instance/@TmcHash')?.category, 'metadata');
  assert.equal(m.get('symbols/PlcTask Inputs/MAIN.bStart/BitOffs')?.category, 'layout');
  assert.equal(m.get('symbols/PlcTask Inputs/ByteSize')?.category, 'layout');
  assert.equal(m.get('unrestored/Plc/Box 1/Inputs^bIn')?.value, 'MAIN.bStart (ANotFound)');
});

test('flattenConfig handles the split variant', () => {
  const pointer = flattenConfig(SPLIT_POINTER).map(e => e.key);
  assert.ok(pointer.includes('project/@AmsPort'));
  assert.ok(pointer.includes('TcVersion'));
  assert.ok(!pointer.some(k => k.startsWith('tasks/') || k.startsWith('types/')));
  const inst = flattenConfig(SPLIT_INSTANCE).map(e => e.key);
  assert.ok(inst.includes('tasks/PlcTask/Priority'));
  assert.ok(inst.includes('types/ST_Motor/BitSize'));
});

test('flattenConfig puts unknown elements into other and links into links', () => {
  const es = flattenConfig(ETHERCAT_XTI);
  assert.ok(es.some(e => e.key.startsWith('other/') && e.category === 'other'));
  assert.ok(es.some(e => e.key.startsWith('links/') && e.category === 'links'));
  const links = byKey(flattenConfig(PLC_XTI));
  assert.equal(links.get('links/Plc/Term 1/Inputs^bStart')?.value, 'Channel 1^Input');
});

test('flattenConfig escapes key parts', () => {
  const xml = PLC_XTI.replace('MAIN.bStart', 'A/B#1');
  const keys = flattenConfig(xml).map(e => e.key);
  assert.ok(keys.includes('symbols/PlcTask Inputs/A%2FB%231/BaseType'));
  assert.ok(!keys.some(k => k.includes('/A/B')));
});

test('flattenConfig keeps raw text next to the normalised value', () => {
  const e = byKey(flattenConfig(PLC_XTI.replace('Start button', 'Start   button'))).get('symbols/PlcTask Inputs/MAIN.bStart/Comment')!;
  assert.equal(e.value, 'Start button');
  assert.equal(e.raw, 'Start   button');
});

test('cycleTimeText converts 100 ns ticks', () => {
  assert.equal(cycleTimeText('100000'), '10 ms');
  assert.equal(cycleTimeText('120000'), '12 ms');
  assert.equal(cycleTimeText('5000'), '0.5 ms');
  assert.equal(cycleTimeText('abc'), 'abc');
});

const line = (c: ConfigChange) => `${c.kind} ${c.key} ${c.before ?? ''}${c.kind === 'changed' ? ' -> ' : ''}${c.after ?? ''}`.trim();

test('diffConfig reports added, removed and changed by key', () => {
  const before = flattenConfig(PLC_XTI);
  const after = flattenConfig(PLC_XTI
    .replace('<CycleTime>100000', '<CycleTime>120000')
    .replace(`<License><LicenseId>${LIC}</LicenseId></License>\n          <License>`, '<License>')
    .replace('</DataArea>', '<Symbol><Name>MAIN.bStop</Name><BaseType>BOOL</BaseType></Symbol></DataArea>'));
  const lines = diffConfig(before, after).map(line);
  assert.ok(lines.includes('changed tasks/PlcTask/CycleTime 10 ms -> 12 ms'), lines.join('\n'));
  assert.ok(lines.includes(`removed licenses/${LIC}#2 present`), lines.join('\n'));
  assert.ok(lines.includes('added symbols/PlcTask Inputs/MAIN.bStop/BaseType BOOL'), lines.join('\n'));
});

test('diffConfig ignores reordering', () => {
  const es = flattenConfig(PLC_XTI);
  assert.deepEqual(diffConfig(es, [...es].reverse()), []);
});

test('diffConfig marks whitespace-only changes', () => {
  const changes = diffConfig(flattenConfig(PLC_XTI), flattenConfig(PLC_XTI.replace('Start button', 'Start   button')));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].noise, 'whitespace');
  assert.equal(changes[0].before, 'Start button');
  assert.equal(changes[0].after, 'Start   button');
});

test('diffConfig pairs reordered duplicates', () => {
  const mk = (...v: string[]): ConfigEntry[] => v.map((x, i) => ({ key: i ? `licenses/L#${i + 1}` : 'licenses/L', value: x, raw: x, category: 'licenses' as const }));
  assert.deepEqual(diffConfig(mk('a', 'b'), mk('b', 'a')), []);
  assert.equal(diffConfig(mk('a', 'b'), mk('b', 'c')).length, 1);
});

test('groupChanges hides by category and noise and counts', () => {
  const hidden = new Set(DEFAULT_HIDDEN);
  const changes: ConfigChange[] = [
    { kind: 'changed', key: 'tasks/T/Priority', category: 'tasks', before: '1', after: '2' },
    { kind: 'changed', key: 'symbols/A/x/BitOffs', category: 'layout', before: '1', after: '2' },
    { kind: 'changed', key: 'types/T/@GUID', category: 'types', noise: 'guid', before: '1', after: '2' },
    { kind: 'changed', key: 'links/A/B/C', category: 'links', before: '1', after: '2' },
  ];
  const g = groupChanges(changes, hidden);
  assert.deepEqual(g.groups.map(x => [x.category, x.shown.length, x.hidden]), [['tasks', 1, 0], ['types', 0, 1], ['layout', 0, 1]]);
  assert.equal(g.hiddenBy.layout, 1);
  assert.equal(g.hiddenBy.guid, 1);
  assert.equal(g.links, 1);
});

test('groupChanges limits each category', () => {
  const changes: ConfigChange[] = Array.from({ length: 1200 }, (_, i) => ({ kind: 'added', key: `symbols/a/s${i}/BaseType`, category: 'symbols', after: 'INT' }));
  const [group] = groupChanges(changes, new Set(), 500).groups;
  assert.equal(group.shown.length, 500);
  assert.equal(group.total, 1200);
});

test('configToYaml leaves out hidden entries', () => {
  const yaml = configToYaml(flattenConfig(PLC_XTI), new Set(DEFAULT_HIDDEN));
  assert.ok(yaml.includes('tasks:'));
  assert.ok(yaml.includes('CycleTime: 10 ms'));
  assert.ok(!yaml.includes('BitOffs'));
  assert.ok(!yaml.includes('__TO_STRING__'));
});
