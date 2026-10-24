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

  console.log('E2E OK');
}
