// Green ST comments (iecode.greenComments): some themes render comments grey, close to code. A decoration
// instead of a token color customization, so it can be switched off and the user's textMateRules stay theirs.

import * as vscode from 'vscode';
import { tokenize } from './lexer';

const LANG = 'twincat-st';

export function register(ctx: vscode.ExtensionContext) {
  const deco = vscode.window.createTextEditorDecorationType({ light: { color: '#008000' }, dark: { color: '#6A9955' } });
  ctx.subscriptions.push(deco);

  const enabled = () => {
    const kind = vscode.window.activeColorTheme.kind;
    // high contrast themes pick their colors for accessibility; leave them alone
    return vscode.workspace.getConfiguration('iecode').get<boolean>('greenComments', true)
      && kind !== vscode.ColorThemeKind.HighContrast && kind !== vscode.ColorThemeKind.HighContrastLight;
  };

  const paint = (ed: vscode.TextEditor) => {
    if (ed.document.languageId !== LANG) return;
    const doc = ed.document;
    ed.setDecorations(deco, enabled()
      ? tokenize(doc.getText(), true).filter(t => t.type === 'comment')
        .map(t => new vscode.Range(doc.positionAt(t.offset), doc.positionAt(t.offset + t.text.length)))
      : []);
  };
  const paintAll = () => vscode.window.visibleTextEditors.forEach(paint);

  let timer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(paint)),
    vscode.window.onDidChangeActiveColorTheme(paintAll),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.greenComments')) paintAll(); }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== LANG) return;
      clearTimeout(timer);
      timer = setTimeout(() => vscode.window.visibleTextEditors.filter(ed => ed.document === e.document).forEach(paint), 150);
    }),
    { dispose: () => clearTimeout(timer) },
  );
  paintAll();
}
