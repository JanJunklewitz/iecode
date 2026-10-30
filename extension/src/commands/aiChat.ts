// "Add to AI Chat" and "Comment for AI…": sends the selected ST (or the section at the cursor) or a visualization
// element to GitHub Copilot Chat (prefilled, not sent) or Claude Code (clipboard + open its panel), see iecode.aiChat.

import * as vscode from 'vscode';
import { AiContext, aiPrompt, stAiContext, visuAiContext } from '../core/aicontext';
import { parseVisu } from '../core/tcvis';

/** Arguments from the visualization editor: its right-click menu (data-vscode-context) or its buttons. */
interface VisuArg { file: string; guid?: string }

type Target = 'copilot' | 'claude' | 'clipboard';

function target(): Target {
  const set = vscode.workspace.getConfiguration('iecode').get<string>('aiChat', 'auto');
  if (set === 'copilot' || set === 'claude' || set === 'clipboard') return set;
  if (vscode.extensions.getExtension('anthropic.claude-code')) return 'claude';
  if (vscode.extensions.getExtension('github.copilot-chat')) return 'copilot';
  return 'clipboard';
}

/** Hands the prompt to the configured chat; falls back to the clipboard. */
export async function sendToAiChat(text: string): Promise<void> {
  const t = target();
  if (t === 'copilot') {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: text, isPartialQuery: true });
      return;
    } catch { /* no chat: clipboard */ }
  }
  await vscode.env.clipboard.writeText(text);
  if (t === 'claude') {
    // Claude Code takes no text from other extensions; its @-mention of the ST view would point into the XML file
    await Promise.resolve(vscode.commands.executeCommand('claude-vscode.editor.openLast')).catch(() => undefined);
    vscode.window.showInformationMessage('IECode: context copied, paste it into Claude Code (Ctrl+V).');
  } else {
    vscode.window.showInformationMessage('IECode: context copied to the clipboard, paste it into your AI chat.');
  }
}

/** The visualization element (or the whole visualization) of the editor's open document. */
export function visuContext(arg: VisuArg): AiContext | undefined {
  const uri = vscode.Uri.parse(arg.file);
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (!doc) return undefined;
  return visuAiContext(parseVisu(doc.getText()), vscode.workspace.asRelativePath(uri), arg.guid || undefined);
}

function editorContext(): AiContext | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const sel = ed.selection;
  // a selection ending at the start of a line doesn't include that line
  const to = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const file = vscode.workspace.asRelativePath(ed.document.uri.with({ scheme: 'file' }));
  const c = stAiContext(ed.document.getText(), sel.start.line, to, file, sel.isEmpty);
  if (ed.document.uri.scheme !== 'iecode') c.lang = ed.document.languageId === 'twincat-st' ? 'st' : ed.document.languageId;
  return c;
}

async function run(arg: unknown, comment: boolean) {
  const v = arg && typeof arg === 'object' && 'file' in arg && typeof (arg as VisuArg).file === 'string' ? arg as VisuArg : undefined;
  const c = v ? visuContext(v) : editorContext();
  if (!c) return vscode.window.showInformationMessage('IECode: nothing to send, select code or a visualization element.');
  let text = '';
  if (comment) {
    const t = await vscode.window.showInputBox({ title: `Comment for AI: ${c.what}`, prompt: 'What should the AI do with it?', ignoreFocusOut: true });
    if (t === undefined) return;
    text = t;
  }
  await sendToAiChat(aiPrompt(c, text));
}

export function registerAiChat(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('iecode.aiAdd', (arg?: unknown) => run(arg, false)),
    vscode.commands.registerCommand('iecode.aiComment', (arg?: unknown) => run(arg, true)),
  );
}
