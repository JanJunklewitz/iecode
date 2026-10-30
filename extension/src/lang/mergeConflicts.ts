// Merge conflict resolution in the ST view. VS Code's built-in merge-conflict extension only serves
// file:/untitled: documents, so the iecode: view gets its own CodeLens and highlighting.

import * as vscode from 'vscode';
import { Choice, findConflicts, resolveLines } from './conflicts';

const SCHEME = 'iecode';

export function register(ctx: vscode.ExtensionContext) {
  const bg = (name: string, ruler = false) => vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor(name),
    ...(ruler ? { overviewRulerColor: new vscode.ThemeColor(name), overviewRulerLane: vscode.OverviewRulerLane.Full } : {}),
  });
  const deco = {
    currentHeader: bg('merge.currentHeaderBackground', true),
    current: bg('merge.currentContentBackground'),
    base: bg('merge.commonContentBackground'),
    incoming: bg('merge.incomingContentBackground'),
    incomingHeader: bg('merge.incomingHeaderBackground', true),
  };
  const changed = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(...Object.values(deco), changed);

  const paint = (ed: vscode.TextEditor) => {
    if (ed.document.uri.scheme !== SCHEME) return;
    const blocks = findConflicts(ed.document.getText());
    const lines = (a: number, b: number) => (a < b ? [new vscode.Range(a, 0, b - 1, 0)] : []);
    ed.setDecorations(deco.currentHeader, blocks.map(b => new vscode.Range(b.start, 0, b.start, 0)));
    ed.setDecorations(deco.current, blocks.flatMap(b => lines(b.start + 1, b.base ?? b.sep)));
    ed.setDecorations(deco.base, blocks.flatMap(b => (b.base === undefined ? [] : lines(b.base, b.sep))));
    ed.setDecorations(deco.incoming, blocks.flatMap(b => lines(b.sep + 1, b.end)));
    ed.setDecorations(deco.incomingHeader, blocks.map(b => new vscode.Range(b.end, 0, b.end, 0)));
  };

  const accept = async (uri: vscode.Uri, start: number, choice: Choice) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const b = findConflicts(doc.getText()).find(x => x.start === start);
    if (!b) return;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const keep = resolveLines(doc.getText().split(/\r?\n/), b, choice);
    const edit = new vscode.WorkspaceEdit();
    // replace whole lines, including the line break after >>>>>>>
    const end = b.end + 1 < doc.lineCount ? new vscode.Position(b.end + 1, 0) : doc.lineAt(b.end).range.end;
    edit.replace(uri, new vscode.Range(b.start, 0, end.line, end.character), keep.length ? keep.join(eol) + (end.character ? '' : eol) : '');
    await vscode.workspace.applyEdit(edit);
  };

  let timer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.mergeAccept', accept),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, {
      onDidChangeCodeLenses: changed.event,
      provideCodeLenses: doc => findConflicts(doc.getText()).flatMap(b => {
        const r = new vscode.Range(b.start, 0, b.start, 0);
        const lens = (title: string, choice: Choice) => new vscode.CodeLens(r, { title, command: 'iecode.mergeAccept', arguments: [doc.uri, b.start, choice] });
        return [lens('Accept Current Change', 'current'), lens('Accept Incoming Change', 'incoming'), lens('Accept Both Changes', 'both')];
      }),
    }),
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(paint)),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== SCHEME) return;
      clearTimeout(timer);
      timer = setTimeout(() => { vscode.window.visibleTextEditors.filter(ed => ed.document === e.document).forEach(paint); changed.fire(); }, 100);
    }),
    { dispose: () => clearTimeout(timer) },
  );
  vscode.window.visibleTextEditors.forEach(paint);
}
