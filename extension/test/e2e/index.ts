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
  // the git extension opens the repository some time after start (slower on Windows); wait for it and for the redirect
  const until = async <T>(get: () => T | undefined, ms = 15000): Promise<T | undefined> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) { const v = get(); if (v) return v; }
    return undefined;
  };
  const stDiff = () => until(() => {
    const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return t instanceof vscode.TabInputTextDiff && t.original.scheme === 'iecode-src' ? t : undefined;
  });
  type GitApi = { repositories: { state: { workingTreeChanges: { uri: vscode.Uri }[] } }[]; toGitUri(uri: vscode.Uri, ref: string): vscode.Uri };
  const gitApi = (await vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')!.activate()).getAPI(1);
  // the nested conflict repo may be detected too, so search all repositories
  const change = await until(() => gitApi.repositories.flatMap(r => r.state.workingTreeChanges).find(c => c.uri.path.endsWith('/FB_Motor.TcPOU')));
  assert.ok(change, 'git sees the changed file');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // what clicking the file in the Source Control view opens (git.openChange finds no resource on Windows: c: vs C:)
  await vscode.commands.executeCommand('vscode.diff', gitApi.toGitUri(change.uri, 'HEAD'), change.uri, 'FB_Motor.TcPOU (Working Tree)');
  const scm = await stDiff();
  assert.ok(scm instanceof vscode.TabInputTextDiff, 'SCM diff open');
  assert.deepEqual([scm.original.scheme, scm.modified.scheme], ['iecode-src', 'iecode'], 'SCM diff redirected to ST');
  const left = await vscode.workspace.openTextDocument(scm.original);
  assert.ok(left.getText().includes('Start := TRUE;') && !left.getText().includes('CDATA'), 'SCM diff original shown as ST');

  // a diff from a scheme with only a content provider and no file system (like git-graph: of the Git Graph extension)
  const graphXml = before.replace('Start := TRUE;', 'Start := bGraph;');
  const graph = vscode.workspace.registerTextDocumentContentProvider('e2e-graph', { provideTextDocumentContent: () => graphXml });
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path).with({ scheme: 'e2e-graph' }), vscode.Uri.file(path), 'Git Graph diff');
  const graphTab = await stDiff();
  assert.ok(graphTab instanceof vscode.TabInputTextDiff, 'Git Graph diff open');
  assert.deepEqual([graphTab.original.scheme, graphTab.modified.scheme], ['iecode-src', 'iecode'], 'Git Graph diff redirected to ST');
  const graphLeft = (await vscode.workspace.openTextDocument(graphTab.original)).getText();
  assert.ok(graphLeft.includes('Start := bGraph;') && !graphLeft.includes('CDATA'), 'content-provider-only side shown as ST');
  graph.dispose();

  // IO links of the fixture project
  const { linksAt } = await import('../../src/core/iohistory');
  const links = await linksAt(join(ws, 'ws/apps/MachineX/MachineX/MachineX.tsproj'), undefined);
  assert.equal(links.length, 2);
  const changes = (await import('../../src/core/iolinks')).diffLinks(await linksAt(join(ws, 'ws/apps/MachineX/MachineX/MachineX.tsproj'), 'HEAD'), links);
  assert.equal(changes.length, 0, 'no IO link changes since HEAD');
  await vscode.commands.executeCommand('iecode.ioLinks');
  // context menu of a .tsproj: IO links of HEAD and the working copy as YAML in the diff editor
  await vscode.commands.executeCommand('iecode.ioLinksDiff', vscode.Uri.file(join(ws, 'ws/apps/MachineX/MachineX/MachineX.tsproj')));
  const io = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(io instanceof vscode.TabInputTextDiff && io.modified.scheme === 'iecode-io', 'IO links YAML diff open');
  const yaml = await vscode.workspace.openTextDocument(io.modified);
  assert.match(yaml.getText(), /^# IO links of MachineX\.tsproj \(working copy\): 2 link\(s\)\n/, 'YAML of the working copy');
  assert.equal(yaml.languageId, 'yaml');

  // ADS interface from the source code (no build output in the fixture)
  const ads = await import('../../src/core/adsinterface');
  const plc = await (await import('../../src/core/projects')).loadPlcProject(join(ws, 'ws/apps/MachineX/MachineX/PLC1/PLC1.plcproj'));
  assert.ok((await ads.fromSourceAt(plc, undefined)).symbols.some(s => s.name === 'MAIN.fbMotor'), 'MAIN.fbMotor from source');
  await vscode.commands.executeCommand('iecode.adsInterface');

  // visualizations: the visual editor opens by default, the YAML summary follows unsaved edits, compare shows YAML
  const visPath = join(ws, 'VI_Demo.TcVIS');
  const visUri = vscode.Uri.file(visPath);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.open', visUri);
  const visTab = await until(() => { const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input; return t instanceof vscode.TabInputCustom ? t : undefined; });
  assert.ok(visTab instanceof vscode.TabInputCustom && visTab.viewType === 'iecode.visuEditor', 'visual editor opens for .TcVIS');
  const visDoc = await vscode.workspace.openTextDocument(visUri);
  const tcvis = await import('../../src/core/tcvis');
  const moved = tcvis.applyEdits(visDoc.getText(), [{ element: 'aaaaaaaa-0000-0000-0000-000000000001', member: tcvis.propertyId('m_StaticPosition.iX'), value: '77' }]);
  const we = new vscode.WorkspaceEdit();
  we.replace(visUri, new vscode.Range(0, 0, visDoc.lineCount, 0), moved);
  await vscode.workspace.applyEdit(we);
  await vscode.commands.executeCommand('iecode.openVisuText', visUri);
  const summary = vscode.window.activeTextEditor!.document;
  assert.equal(summary.languageId, 'yaml');
  assert.match(summary.getText(), /at: \[77, 20\]/, 'summary shows the unsaved edit');
  await visDoc.save();
  await vscode.commands.executeCommand('iecode.compareWithHead', visUri);
  const visDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(visDiff instanceof vscode.TabInputTextDiff && visDiff.original.scheme === 'iecode-rev', 'visualization compare open');
  const visLeft = await vscode.workspace.openTextDocument(visDiff.original);
  const visRight = await vscode.workspace.openTextDocument(visDiff.modified);
  assert.match(visLeft.getText(), /at: \[10, 20\]/, 'HEAD as YAML');
  assert.match(visRight.getText(), /at: \[77, 20\]/, 'working copy as YAML');
  assert.equal(visLeft.languageId, 'yaml');
  // a diff of two versions (Source Control, Git Graph) shows both as YAML instead of XML
  const visOld = vscode.workspace.registerTextDocumentContentProvider('e2e-vis', { provideTextDocumentContent: () => tcvis.applyEdits(moved, [{ element: 'aaaaaaaa-0000-0000-0000-000000000001', member: tcvis.propertyId('m_StaticPosition.iX'), value: '5' }]) });
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.diff', visUri.with({ scheme: 'e2e-vis' }), visUri, 'VI_Demo.TcVIS (Working Tree)');
  const visScm = await until(() => { const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input; return t instanceof vscode.TabInputTextDiff && t.original.scheme === 'iecode-src' ? t : undefined; });
  assert.ok(visScm, 'visualization diff redirected');
  assert.match((await vscode.workspace.openTextDocument(visScm.original)).getText(), /at: \[5, 20\]/);
  assert.match((await vscode.workspace.openTextDocument(visScm.modified)).getText(), /at: \[77, 20\]/);
  visOld.dispose();

  // merge conflict (nested repo from scripts/conflict-repo.sh): auto-resolve the XML, resolve the code conflict in the ST view
  const cPath = join(ws, 'conflict/FB_Motor.TcPOU');
  const cUri = vscode.Uri.file(cPath);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(cUri);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'file', 'conflicted file stays XML');
  await vscode.commands.executeCommand('iecode.autoResolveXml', cUri);
  const cView = await until(() => { const d = vscode.window.activeTextEditor?.document; return d?.uri.scheme === 'iecode' ? d : undefined; });
  assert.ok(cView, 'auto-resolve opens the ST view');
  assert.equal(cView.uri.fsPath, cUri.fsPath, 'ST view of the conflicted file');
  assert.equal(cView.getText().split(/\r?\n/).filter(l => l.startsWith('<<<<<<<')).length, 1, 'one code conflict left');
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', cView.uri);
  assert.deepEqual(lenses.map(l => l.command?.title), ['Accept Current Change', 'Accept Incoming Change', 'Accept Both Changes']);
  const start = lenses[0].command!.arguments![1] as number;
  await vscode.commands.executeCommand('iecode.mergeAccept', cView.uri, start, 'current');
  assert.ok(await cView.save(), 'resolved view saved');
  const resolved = await fs.readFile(cPath, 'utf8');
  assert.ok(!/^(<{7}|={7}|>{7})(?:\s|$)/m.test(resolved), 'no conflict marker left on disk');
  const { decode } = await import('../../src/model');
  assert.ok(decode(resolved).includes('TRUE AND FALSE'), 'decodes, kept the current side');

  // library manager and graph open without errors
  await vscode.commands.executeCommand('iecode.libraries');
  await vscode.commands.executeCommand('iecode.showGraph');
  await new Promise(r => setTimeout(r, 1000));

  console.log('E2E OK');
}
