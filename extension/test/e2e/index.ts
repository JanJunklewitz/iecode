// Runs inside the VS Code extension host (see scripts/e2e.sh).
import * as vscode from 'vscode';
import * as assert from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const path = join(ws, 'FB_Motor.TcPOU');
  const before = await fs.readFile(path, 'utf8');

  // opening the XML file from "the explorer" must redirect to the ST view
  await vscode.window.showTextDocument(vscode.Uri.file(path));
  await new Promise(r => setTimeout(r, 1500));
  const ed = vscode.window.activeTextEditor!;
  assert.equal(ed.document.uri.scheme, 'iecode', 'redirected to ST view');
  assert.equal(ed.document.languageId, 'twincat-st');
  assert.ok(!ed.document.getText().includes('CDATA'));

  const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', ed.document.uri);
  assert.deepEqual(syms.map(s => s.name), ['FB_Motor', 'Start', 'Speed', 'Speed.get', 'Reset', 'Diagram']);

  const text = ed.document.getText();
  const at = text.indexOf('Start := TRUE;');
  await ed.edit(b => b.replace(new vscode.Range(ed.document.positionAt(at), ed.document.positionAt(at + 14)), 'Start := bRunning;'));
  assert.ok(await ed.document.save(), 'saved');
  const after = await fs.readFile(path, 'utf8');
  assert.ok(after.includes('Start := bRunning;]]></ST>'));
  assert.equal(after.replace('Start := bRunning;', 'Start := TRUE;').replace(/    <LineIds Name="FB_Motor.Start">\r\n.*\r\n    <\/LineIds>\r\n/, ''),
    before.replace(/    <LineIds Name="FB_Motor.Start">\r\n.*\r\n    <\/LineIds>\r\n/, ''), 'only the method body changed');

  // invalid view must fail to save and leave the file untouched
  await ed.edit(b => b.insert(new vscode.Position(ed.document.lineCount, 0), '//==== GET Nope ====\n'));
  const ok = await ed.document.save();
  assert.equal(ok, false, 'invalid save rejected');
  assert.equal(await fs.readFile(path, 'utf8'), after);
  await vscode.commands.executeCommand('workbench.action.files.revert');

  // external change (e.g. TwinCAT XAE saved) reloads the view
  await fs.writeFile(path, after.replace('bEnable := TRUE;', 'bEnable := FALSE;'));
  await new Promise(r => setTimeout(r, 2500));
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('bEnable := FALSE;'), 'reloaded after external change');
  // project tree: the workspace model finds the fixture solutions and loose library project
  const model = await vscode.commands.executeCommand<{ units: { id: string; group: string }[] }>('iecode.refresh');
  assert.deepEqual(model.units.map(u => `${u.group}:${u.id}`).sort(),
    ['application:MachineX/PLC1', 'library:Logging', 'library:Tc3_MotorLib/MotorLib'], 'workspace model');

  // language features on the ST view: definition of a method call, hover, completion after '.'
  const main = vscode.Uri.file(join(ws, 'ws/apps/MachineX/MachineX/PLC1/POUs/MAIN.TcPOU')).with({ scheme: 'iecode' });
  const mainDoc = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(mainDoc);
  await new Promise(r => setTimeout(r, 1500));
  const callAt = mainDoc.positionAt(mainDoc.getText().indexOf('fbMotor(') + 2);
  const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', main, callAt);
  assert.equal(defs.length, 1, 'definition found');
  assert.equal(mainDoc.lineAt(defs[0].range.start.line).text.trim(), 'fbMotor : FB_Motor;');
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', main, callAt);
  assert.match(String((hovers[0].contents[0] as vscode.MarkdownString).value), /fbMotor : FB_Motor/);

  // compare as ST: the HEAD version (before the edit above) is shown without XML
  const rev = await vscode.workspace.openTextDocument(vscode.Uri.file(path).with({ scheme: 'iecode-rev', query: 'ref=HEAD&label=HEAD' }));
  assert.ok(rev.getText().includes('Start := TRUE;') && !rev.getText().includes('CDATA'), 'HEAD shown as ST');
  await vscode.commands.executeCommand('iecode.compareWithHead', vscode.Uri.file(path));

  // a diff from the Source Control view (git: ↔ file:) is replaced by the ST diff
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(path));
  await new Promise(r => setTimeout(r, 2500));
  const scm = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(scm instanceof vscode.TabInputTextDiff, 'SCM diff open');
  assert.deepEqual([scm.original.scheme, scm.modified.scheme], ['iecode-src', 'iecode'], 'SCM diff redirected to ST');
  const left = await vscode.workspace.openTextDocument(scm.original);
  assert.ok(left.getText().includes('Start := TRUE;') && !left.getText().includes('CDATA'), 'SCM diff original shown as ST');

  // IO links of the fixture project
  const { linksAt } = await import('../../src/core/iohistory');
  const links = await linksAt(join(ws, 'ws/apps/MachineX/MachineX/MachineX.tsproj'), undefined);
  assert.equal(links.length, 2);
  const changes = (await import('../../src/core/iolinks')).diffLinks(await linksAt(join(ws, 'ws/apps/MachineX/MachineX/MachineX.tsproj'), 'HEAD'), links);
  assert.equal(changes.length, 0, 'no IO link changes since HEAD');
  await vscode.commands.executeCommand('iecode.ioLinks');

  // ADS interface from the source code (no build output in the fixture)
  const ads = await import('../../src/core/adsinterface');
  const plc = await (await import('../../src/core/projects')).loadPlcProject(join(ws, 'ws/apps/MachineX/MachineX/PLC1/PLC1.plcproj'));
  assert.ok((await ads.fromSourceAt(plc, undefined)).symbols.some(s => s.name === 'MAIN.fbMotor'), 'MAIN.fbMotor from source');
  await vscode.commands.executeCommand('iecode.adsInterface');

  // library manager and graph open without errors
  await vscode.commands.executeCommand('iecode.libraries');
  await vscode.commands.executeCommand('iecode.showGraph');
  await new Promise(r => setTimeout(r, 1000));

  console.log('E2E OK');
}
