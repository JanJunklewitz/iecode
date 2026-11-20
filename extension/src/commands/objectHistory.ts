// History of one object or member: a list of the commits that changed it, and a diff of one commit.

import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryEntry, fileTextOf, historyItemLabel, objectHistory, sectionTextOf } from '../core/objectHistory';
import { blobsAt, repoRoot } from '../core/git';
import { decode, outline } from '../model';
import type { Node } from '../views/tree';

export const SECTION_SCHEME = 'iecode-section';
const MAX = 200;

/** Texts of the diff sides, by URI string; the provider serves them. */
const texts = new Map<string, string>();

function sideUri(file: string, key: string, short: string, side: 'before' | 'after'): vscode.Uri {
  const name = `${key.replace(':', ' ')} ${side} ${short}.st`;
  return vscode.Uri.from({ scheme: SECTION_SCHEME, path: `/${name}`, query: `${file}|${key}|${short}|${side}` });
}

/** What the command was asked for: a file and a section key, or the whole file. */
async function target(arg: unknown): Promise<{ file: string; key: string; label: string } | undefined> {
  const node = arg as Node | undefined;
  if (node && typeof node === 'object' && 'kind' in node) {
    if (node.kind === 'object') return { file: node.obj.file, key: 'FILE', label: node.obj.name };
    if (node.kind === 'member') {
      const k = node.member.kind;
      return { file: node.obj.file, key: `${k}:${node.member.name}`, label: `${node.obj.name}.${node.member.name}` };
    }
    return undefined;
  }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'iecode') return undefined;
  const file = ed.document.uri.with({ scheme: 'file' }).fsPath;
  const head = outline(ed.document.getText()).filter(h => h.line <= ed.selection.active.line).pop();
  if (!head) return { file, key: 'MAIN', label: vscode.workspace.asRelativePath(file) };
  return { file, key: `${head.kind}:${head.name}`, label: `${head.kind.toLowerCase()} ${head.name}` };
}

export function registerObjectHistory(ctx: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(
    changed,
    vscode.workspace.registerTextDocumentContentProvider(SECTION_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: uri => texts.get(uri.toString()) ?? '',
    }),
    vscode.commands.registerCommand('iecode.objectHistory', async (arg?: unknown) => {
      const t = await target(arg);
      if (!t) { vscode.window.showInformationMessage('IECode: select an object or member in the project tree, or put the cursor in the ST view.'); return; }
      const root = await repoRoot(t.file);
      if (!root) { vscode.window.showInformationMessage('IECode: the file is not in a git repository.'); return; }

      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `History of ${t.label}`, cancellable: false },
        () => objectHistory(root, t.file, t.key, MAX));

      const entries: HistoryEntry[] = [...result.entries];
      const wc = await workingCopyEntry(root, t.file, t.key, result.entries[0]);
      type Item = vscode.QuickPickItem & { entry: HistoryEntry };
      const items: Item[] = [...(wc ? [wc] : []), ...entries].map(e => e.commit === 'WORKING'
        ? { label: 'Working copy', description: 'uncommitted changes', entry: e }
        : { ...historyItemLabel(e), entry: e });
      if (!items.length) { vscode.window.showInformationMessage(`IECode: no commit changed ${t.label}${result.cut ? ` among the newest ${MAX} commits of the file` : ''}.`); return; }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `${t.label}: ${items.length} change${items.length === 1 ? '' : 's'}${result.cut ? `, showing the newest ${MAX}` : ''}`,
      });
      if (!pick) return;
      if (pick.entry.change === 'unreadable') { vscode.window.showInformationMessage('IECode: the XML of this commit could not be read (for example merge conflict markers), so there is nothing to compare.'); return; }
      const e = pick.entry;
      const left = sideUri(t.file, e.key, e.short, 'before'), right = sideUri(t.file, e.key, e.short, 'after');
      texts.set(left.toString(), e.before ?? '');
      texts.set(right.toString(), e.after ?? '');
      changed.fire(left); changed.fire(right);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${e.key} @ ${e.short}`);
    }),
  );
}

/** A top entry when the section in the working copy differs from HEAD. */
async function workingCopyEntry(root: string, file: string, key: string, newest?: HistoryEntry): Promise<HistoryEntry | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    const work = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    const rel = path.relative(root, file).split(path.sep).join('/');
    const head = (await blobsAt(root, [{ ref: 'HEAD', file: rel }])).get(`HEAD:${rel}`);
    if (head === undefined) return undefined;
    const text = (xml: string) => key === 'FILE' ? fileTextOf(xml) : sectionTextOf(xml, decode(xml), key);
    const before = text(head.replace(/^﻿/, '')), after = text(work);
    if (before === after) return undefined;
    return { commit: 'WORKING', short: 'working', date: '', author: '', subject: 'Working copy', key: newest?.key ?? key, change: 'changed', before, after };
  } catch { return undefined; }
}
