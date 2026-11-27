import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { findUnreferencedFiles, planSaveAllIndependent, writeSaveAllPlan } from '../src/core/independentFiles';
import { readProject, buildTree, treeToYaml } from '../src/core/iotree';

const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);

const TSPROJ = `<?xml version="1.0"?>
<TcSmProject>
\t<Project>
\t\t<Io>
\t\t\t<Device File="Device 1 (EtherCAT).xti" Id="1"/>
\t\t\t<Device Id="2" RemoteName="Device 2 (Inline)">
\t\t\t\t<Name>Device 2 (Inline)</Name>
\t\t\t\t<Box File="Kept By Inline Device.xti" Id="9"/>
\t\t\t</Device>
\t\t</Io>
\t</Project>
</TcSmProject>`;

// A coupler with a digital terminal, a serial terminal (BoxType 9101), a disabled terminal and a junction that
// holds a box whose name has a '/'. One data type and one image only the moved boxes use, one the device keeps.
const DEVICE = `<?xml version="1.0"?>
<TcSmItem TcSmVersion="1.0" TcVersion="3.1.4024.66" ClassName="CDevEtherCATDef" SubType="111">
\t<DataTypes>
\t\t<DataType>
\t\t\t<Name GUID="{00000000-0000-0000-0000-000000000001}">ARRAY [0..3] OF BIT</Name>
\t\t</DataType>
\t\t<DataType>
\t\t\t<Name GUID="{00000000-0000-0000-0000-000000000002}">DEVICE TYPE</Name>
\t\t</DataType>
\t</DataTypes>
\t<ImageDatas>
\t\t<ImageData Id="1000">aa</ImageData>
\t\t<ImageData Id="1001">bb</ImageData>
\t</ImageDatas>
\t<Device Id="1" DevType="111">
\t\t<Name>__FILENAME__</Name>
\t\t<Image Id="1" AddrType="1" ImageType="1">
\t\t\t<Var><Type GUID="{00000000-0000-0000-0000-000000000002}">DEVICE TYPE</Type></Var>
\t\t</Image>
\t\t<Box Id="1" BoxType="9099">
\t\t\t<Name>Coupler (EK1100)</Name>
\t\t\t<ImageId>1000</ImageId>
\t\t\t<EtherCAT Type="EK1100"/>
\t\t\t<Box Id="2" BoxType="9099">
\t\t\t\t<Name>Inputs (EL1004)</Name>
\t\t\t\t<ImageId>1001</ImageId>
\t\t\t\t<EtherCAT Type="EL1004" PortABoxInfo="#x00000001">
\t\t\t\t\t<Pdo Name="Inputs"><Entry Name="Input 1"><Type GUID="{00000000-0000-0000-0000-000000000001}">ARRAY [0..3] OF BIT</Type></Entry></Pdo>
\t\t\t\t</EtherCAT>
\t\t\t</Box>
\t\t\t<Box Id="3" BoxType="9101">
\t\t\t\t<Name>Serial (EL6001)</Name>
\t\t\t\t<EtherCAT Type="EL6001" PortABoxInfo="#x00000002"/>
\t\t\t</Box>
\t\t\t<Box Id="4" Disabled="true" BoxType="9099">
\t\t\t\t<Name>Spare (EL2004)</Name>
\t\t\t\t<EtherCAT Type="EL2004" PortABoxInfo="#x00000003"/>
\t\t\t</Box>
\t\t\t<Box Id="5" BoxType="9099">
\t\t\t\t<Name>Junction (EK1122)</Name>
\t\t\t\t<EtherCAT Type="EK1122" PortABoxInfo="#x00000004"/>
\t\t\t\t<Box Id="6" BoxType="9099">
\t\t\t\t\t<Name>Drive A/B</Name>
\t\t\t\t\t<EtherCAT Type="Drive" PortABoxInfo="#x00000005"/>
\t\t\t\t</Box>
\t\t\t</Box>
\t\t</Box>
\t</Device>
\t<Mappings>
\t\t<OwnerA Name="TIPC^Plc^Plc Instance">
\t\t\t<OwnerB Name="TIID^Device 1 (EtherCAT)^Coupler (EK1100)^Inputs (EL1004)">
\t\t\t\t<Link VarA="PlcTask Inputs^MAIN.bIn" VarB="Inputs^Input 1"/>
\t\t\t</OwnerB>
\t\t</OwnerA>
\t</Mappings>
</TcSmItem>
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-indep-'));
  writeFileSync(join(dir, 'Sys.tsproj'), TSPROJ);
  mkdirSync(join(dir, '_Config', 'IO'), { recursive: true });
  writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT).xti'), DEVICE);
  return dir;
}

test('save all: every inline box moves into its own file, nested ones into the folder of their parent', async () => {
  const dir = project();
  try {
    const tsproj = join(dir, 'Sys.tsproj');
    const io = join(dir, '_Config', 'IO');
    const yaml = async () => { const s = await readProject(tsproj, read); return treeToYaml(buildTree(s.links, s.boxes)); };
    const before = await yaml();

    const plan = await planSaveAllIndependent(tsproj, read);
    const coupler = join(io, 'Device 1 (EtherCAT)', 'Coupler (EK1100).xti');
    const sub = join(io, 'Device 1 (EtherCAT)', 'Coupler (EK1100)');
    assert.deepEqual(plan.created.map(c => c.file).sort(), [
      coupler,
      join(sub, 'Inputs (EL1004).xti'),
      join(sub, 'Junction (EK1122).xti'),
      join(sub, 'Junction (EK1122)', 'Drive A%_2FB.xti'),
      join(sub, 'Serial (EL6001).xti'),
      join(sub, 'Spare (EL2004).xti'),
    ].sort());
    assert.deepEqual(plan.changed.map(c => c.file), [join(io, 'Device 1 (EtherCAT).xti')]);
    assert.deepEqual(plan.replaced, []);
    assert.equal(plan.skipped.length, 1);
    assert.match(plan.skipped[0], /^Device 2 \(Inline\): device stored in the \.tsproj/);

    await writeSaveAllPlan(plan);
    const device = readFileSync(join(io, 'Device 1 (EtherCAT).xti'), 'utf8');
    assert.match(device, /\t\t<Box File="Coupler \(EK1100\)\.xti" Id="1"\/>\n\t<\/Device>/);
    // The device keeps only what it still uses itself.
    assert.ok(device.includes('DEVICE TYPE</Name>') && !device.includes('ARRAY [0..3] OF BIT</Name>'));
    assert.ok(!device.includes('<ImageDatas>'));

    const couplerXti = readFileSync(coupler, 'utf8');
    assert.match(couplerXti, /\n\t\t<Box File="Inputs \(EL1004\)\.xti" Id="2">\n\t\t\t<EtherCAT PortABoxInfo="#x00000001"\/>\n\t\t<\/Box>/);
    assert.ok(couplerXti.includes('<Box File="Junction (EK1122).xti" Id="5">'));
    assert.ok(!couplerXti.includes('ARRAY [0..3] OF BIT'), 'the type moved on with the terminal');
    assert.ok(couplerXti.includes('<ImageData Id="1000">aa</ImageData>') && !couplerXti.includes('bb'));

    const serial = readFileSync(join(sub, 'Serial (EL6001).xti'), 'utf8');
    assert.match(serial, /ClassName="CEL60xxDef" SubType="9101"/);
    assert.match(readFileSync(join(sub, 'Spare (EL2004).xti'), 'utf8'), /<Box Id="4" Disabled="true" BoxType="9099">\n\t\t<Name>__FILENAME__<\/Name>/);
    // A name the file name cannot spell stays written out.
    assert.ok(readFileSync(join(sub, 'Junction (EK1122)', 'Drive A%_2FB.xti'), 'utf8').includes('<Name>Drive A/B</Name>'));

    assert.equal(await yaml(), before);
    const again = await planSaveAllIndependent(tsproj, read);
    assert.equal(again.created.length + again.changed.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save all: an unreferenced file in the way is replaced, two boxes for one file are refused', async () => {
  const dir = project();
  try {
    const tsproj = join(dir, 'Sys.tsproj');
    const stale = join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'Coupler (EK1100).xti');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, '<?xml version="1.0"?>\n<TcSmItem/>\n');
    assert.deepEqual((await planSaveAllIndependent(tsproj, read)).replaced, [stale]);

    const twice = DEVICE.replace('<Name>Spare (EL2004)</Name>', '<Name>Inputs (EL1004)</Name>');
    writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT).xti'), twice);
    await assert.rejects(planSaveAllIndependent(tsproj, read), /Two items would be saved as .*Inputs \(EL1004\)\.xti/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreferenced files: stale .xti and .bak listed, referenced and named files kept', async () => {
  const dir = project();
  try {
    const tsproj = join(dir, 'Sys.tsproj');
    const io = join(dir, '_Config', 'IO');
    const files = {
      stale: join(io, 'Device 1 (EtherCAT)_old.xti'),
      staleBox: join(io, 'Device 1 (EtherCAT)', 'Old Terminal.xti'),
      bak: join(io, 'Device 1 (EtherCAT).xti.bak'),
      named: join(io, 'Kept By Inline Device.xti'),
      other: join(io, 'notes.txt'),
    };
    mkdirSync(join(io, 'Device 1 (EtherCAT)'), { recursive: true });
    for (const f of Object.values(files)) writeFileSync(f, 'x');
    assert.deepEqual(await findUnreferencedFiles(tsproj, read), [files.bak, files.stale, files.staleBox].sort((a, b) => a.localeCompare(b)));

    await writeSaveAllPlan(await planSaveAllIndependent(tsproj, read));
    assert.ok(existsSync(join(io, 'Device 1 (EtherCAT)', 'Coupler (EK1100).xti')));
    assert.deepEqual(await findUnreferencedFiles(tsproj, read), [files.bak, files.stale, files.staleBox].sort((a, b) => a.localeCompare(b)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
