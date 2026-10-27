import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { extractBox, readIoLinkStructure } from '../src/core/iolinkmasters';
import { readProject, buildTree, treeToYaml } from '../src/core/iotree';

const TSPROJ = `<?xml version="1.0"?>
<TcSmProject>
\t<Project><Io><Device File="Device 1 (EtherCAT).xti"/></Io></Project>
</TcSmProject>`;

// A coupler with an IO-Link master (two ports, the second without device) and a digital terminal.
const DEVICE = `<?xml version="1.0"?>
<TcSmItem TcSmVersion="1.0" TcVersion="3.1.4024.66" ClassName="CDevEtherCATDef" SubType="111">
\t<DataTypes>
\t\t<DataType>
\t\t\t<Name GUID="{18071995-0000-0000-0000-002000000004}">ARRAY [0..3] OF BIT</Name>
\t\t\t<BaseType GUID="{18071995-0000-0000-0000-000000000010}">BIT</BaseType>
\t\t</DataType>
\t\t<DataType>
\t\t\t<Name GUID="{18071995-0000-0000-0000-000000000010}">BIT</Name>
\t\t</DataType>
\t\t<DataType>
\t\t\t<Name GUID="{18071995-0000-0000-0000-002000000009}">ARRAY [0..8] OF BIT</Name>
\t\t</DataType>
\t</DataTypes>
\t<ImageDatas>
\t\t<ImageData Id="1000">aa</ImageData>
\t\t<ImageData Id="1001">bb</ImageData>
\t\t<ImageData Id="1002">cc</ImageData>
\t</ImageDatas>
\t<Device Id="1">
\t\t<Name>Device 1 (EtherCAT)</Name>
\t\t<Box Id="1" BoxType="9099">
\t\t\t<Name>Term 1 (EK1100)</Name>
\t\t\t<ImageId>1000</ImageId>
\t\t\t<Box Id="2" BoxType="9099" BoxFlags="#x00000020">
\t\t\t\t<Name>Term 2 (EL6224)</Name>
\t\t\t\t<ImageId>1002</ImageId>
\t\t\t\t<Xml>
\t\t\t\t\t<Port>
\t\t\t\t\t\t<FileName>ACME-Valves-IODD1.1.xml</FileName>
\t\t\t\t\t\t<VendorName>ACME &amp; Co</VendorName>
\t\t\t\t\t\t<DeviceName>VT-8</DeviceName>
\t\t\t\t\t\t<DirectParameter>000003300000014D000011011E00850000000000</DirectParameter>
\t\t\t\t\t</Port>
\t\t\t\t\t<Port/>
\t\t\t\t</Xml>
\t\t\t\t<EtherCAT Type="EL6224 IO-Link Master" PortABoxInfo="#x01000001">
\t\t\t\t\t<Pdo Name="IO-Link Port1" Index="#x1600" InOut="1">
\t\t\t\t\t\t<Entry Name="Valve 1" BitLen="1" Index="#x7000" Sub="#x01"><Type>BIT</Type></Entry>
\t\t\t\t\t\t<Entry Name="Valve 2" BitLen="1" Index="#x7000" Sub="#x02"><Type>BIT</Type></Entry>
\t\t\t\t\t\t<Entry><Type GUID="{18071995-0000-0000-0000-002000000004}">ARRAY [0..3] OF BIT</Type></Entry>
\t\t\t\t\t</Pdo>
\t\t\t\t\t<Slot Name="IO-Link Channel" ImageId="1001">
\t\t\t\t\t\t<Module Type="IO-Link Slave"><Name>Valve terminal</Name><ImageId>1001</ImageId><PdoIndex>5632</PdoIndex></Module>
\t\t\t\t\t</Slot>
\t\t\t\t\t<Slot Name="IO-Link Channel" ImageId="1001"/>
\t\t\t\t</EtherCAT>
\t\t\t</Box>
\t\t\t<Box Id="3" BoxType="9099"><Name>Term 3 (EL1008)</Name><EtherCAT Type="EL1008"/></Box>
\t\t</Box>
\t</Device>
\t<Mappings>
\t\t<OwnerA Name="TIPC^PLC1^PLC1 Instance">
\t\t\t<OwnerB Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL6224)">
\t\t\t\t<Link VarA="PlcTask Outputs^MAIN.bValve1" VarB="Valve terminal^IO-Link Port1^Valve 1"/>
\t\t\t</OwnerB>
\t\t</OwnerA>
\t</Mappings>
</TcSmItem>
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-iolink-'));
  writeFileSync(join(dir, 'Sys.tsproj'), TSPROJ);
  mkdirSync(join(dir, '_Config', 'IO'), { recursive: true });
  writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT).xti'), DEVICE);
  return dir;
}
const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);

test('IO-Link masters with ports, devices, process data and links', async () => {
  const dir = project();
  try {
    const s = await readIoLinkStructure(join(dir, 'Sys.tsproj'), read);
    assert.equal(s.masters.length, 1);
    const m = s.masters[0];
    assert.equal(m.path, 'TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL6224)');
    assert.equal(m.independent, false);
    assert.equal(m.ports.length, 2);
    const [p1, p2] = m.ports;
    assert.equal(p1.number, 1);
    assert.equal(p1.name, 'Valve terminal');
    assert.equal(p1.mode, 'IO-Link Slave');
    assert.deepEqual(p1.device, { vendor: 'ACME & Co', name: 'VT-8', family: undefined, text: undefined, iodd: 'ACME-Valves-IODD1.1.xml', deviceId: 0x330, vendorId: 0x14d });
    assert.deepEqual(p1.entries.map(e => [e.name, e.type, e.linked]), [['Valve 1', 'BIT', ['PLC1^MAIN.bValve1']], ['Valve 2', 'BIT', []]]);
    assert.equal(p2.number, 2);
    assert.equal(p2.name, undefined);
    assert.equal(p2.device, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save as independent project file: box moved like TwinCAT, links and structure unchanged', async () => {
  const dir = project();
  try {
    const tsproj = join(dir, 'Sys.tsproj');
    const yaml = async () => { const s = await readProject(tsproj, read); return treeToYaml(buildTree(s.links, s.boxes)); };
    const before = await yaml();
    const [m] = (await readIoLinkStructure(tsproj, read)).masters;
    const x = extractBox(readFileSync(m.file, 'utf8'), m.file, m.offset);
    assert.equal(x.file, join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'Term 1 (EK1100)', 'Term 2 (EL6224).xti'));
    assert.match(x.parent, /\t\t\t<Box File="Term 2 \(EL6224\)\.xti" Id="2">\n\t\t\t\t<EtherCAT PortABoxInfo="#x01000001"\/>\n\t\t\t<\/Box>\n\t\t\t<Box Id="3"/);
    assert.ok(!x.parent.includes('VT-8'));
    assert.ok(x.content.startsWith('<?xml version="1.0"?>\n<TcSmItem TcSmVersion="1.0" TcVersion="3.1.4024.66" ClassName="CFlbTermDef" SubType="9099">\n\t<DataTypes>\n'));
    assert.ok(x.content.includes('\t<Box Id="2" BoxType="9099" BoxFlags="#x00000020">\n\t\t<Name>__FILENAME__</Name>\n\t\t<ImageId>1000</ImageId>\n\t\t<Xml>\n'));
    // Images renumbered in order of use, only the used data types (and their base types).
    assert.ok(x.content.includes('\t<ImageDatas>\n\t\t<ImageData Id="1000">cc</ImageData>\n\t\t<ImageData Id="1001">bb</ImageData>\n\t</ImageDatas>'));
    assert.ok(x.content.includes('<Slot Name="IO-Link Channel" ImageId="1001">'));
    assert.ok(x.content.includes('ARRAY [0..3] OF BIT</Name>') && x.content.includes('>BIT</Name>') && !x.content.includes('ARRAY [0..8]'));
    assert.ok(!x.content.includes('PortABoxInfo'));
    assert.throws(() => extractBox(x.parent, m.file, m.offset), /No box|already/);

    mkdirSync(dirname(x.file), { recursive: true });
    writeFileSync(x.file, x.content);
    writeFileSync(m.file, x.parent);
    assert.equal(await yaml(), before);
    const after = (await readIoLinkStructure(tsproj, read)).masters;
    assert.equal(after.length, 1);
    assert.equal(after[0].independent, true);
    assert.equal(after[0].path, m.path);
    assert.deepEqual(after[0].ports, (await readIoLinkStructureOf(DEVICE)).ports);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF files keep CRLF', () => {
  const src = DEVICE.replace(/\n/g, '\r\n');
  const offset = src.indexOf('<Box Id="2"');
  const x = extractBox(src, '/p/_Config/IO/Device 1 (EtherCAT).xti', offset);
  assert.ok(!/[^\r]\n/.test(x.content) && !/[^\r]\n/.test(x.parent));
});

async function readIoLinkStructureOf(device: string) {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-iolink-'));
  try {
    writeFileSync(join(dir, 'Sys.tsproj'), TSPROJ);
    mkdirSync(join(dir, '_Config', 'IO'), { recursive: true });
    writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT).xti'), device);
    return (await readIoLinkStructure(join(dir, 'Sys.tsproj'), read)).masters[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
