// Compare TwinCAT objects as plain ST (no XML): with the git HEAD, an earlier commit, two commits,
// or another file. Git can also be set up to show ST in `git diff` (textconv).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { decode } from '../model';
import { isEncrypted } from '../core/projects';
import { config, log, repoRoot, show } from '../core/git';

export const REV_SCHEME = 'iecode-rev';
const EXT_RE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;

/** iecode-rev:/path/X.TcPOU?ref=<commit> shows the ST view of the file at that commit. */
const revUri = (file: string, ref: string, label: string) =>
  vscode.Uri.file(file).with({ scheme: REV_SCHEME, query: new URLSearchParams({ ref, label }).toString() });
const viewUri = (file: string) => vscode.Uri.file(file).with({ scheme: 'iecode' });

function toView(xml: string): string {
  if (isEncrypted(xml)) return '(* encrypted object – content not available *)\n';
  return decode(xml.replace(/^﻿/, ''));
}

/** The file a command was invoked on: explorer / editor / tree node / active editor. */
function targetFile(arg: unknown): string | undefined {
  const fromUri = (u: vscode.Uri) => (EXT_RE.test(u.path) ? u.fsPath : undefined);
  if (arg instanceof vscode.Uri) return fromUri(arg);
  const n = arg as { kind?: string; obj?: { file: string } } | undefined;
  if (n?.obj?.file) return n.obj.file;
  const u = vscode.window.activeTextEditor?.document.uri;
  return u ? fromUri(u) : undefined;
}

async function pickCommit(root: string, file: string, title: string) {
  const commits = await log(root, [file]);
  if (!commits.length) { vscode.window.showInformationMessage('IECode: no git history for this file.'); return; }
  const pick = await vscode.window.showQuickPick(
    commits.map(c => ({ label: `$(git-commit) ${c.short}  ${c.subject}`, description: `${c.date} · ${c.author}`, c })),
    { title, matchOnDescription: true });
  return pick?.c;
}

export function register(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, {
    async provideTextDocumentContent(uri) {
      const ref = new URLSearchParams(uri.query).get('ref') ?? 'HEAD';
      const root = await repoRoot(uri.fsPath);
      if (!root) return '(* not in a git repository *)\n';
      const xml = await show(root, ref, uri.fsPath);
      return xml === undefined ? `(* ${path.basename(uri.fsPath)} doesn't exist in ${ref} *)\n` : toView(xml);
    },
  }));

  const title = (file: string, left: string, right: string) => `${path.basename(file).replace(EXT_RE, '')} (ST): ${left} ↔ ${right}`;
  const reg = (id: string, fn: (arg?: unknown) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try { await fn(arg); } catch (e) { vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); }
    }));

  const needRepo = async (file: string) => {
    const root = await repoRoot(file);
    if (!root) vscode.window.showWarningMessage('IECode: this file is not in a git repository.');
    return root;
  };

  reg('iecode.compareWithHead', async arg => {
    const file = targetFile(arg);
    if (!file || !await needRepo(file)) return;
    await vscode.commands.executeCommand('vscode.diff', revUri(file, 'HEAD', 'HEAD'), viewUri(file), title(file, 'HEAD', 'working copy'));
  });

  reg('iecode.compareWithCommit', async arg => {
    const file = targetFile(arg);
    const root = file && await needRepo(file);
    if (!file || !root) return;
    const c = await pickCommit(root, file, 'Compare the working copy with …');
    if (c) await vscode.commands.executeCommand('vscode.diff', revUri(file, c.hash, c.short), viewUri(file), title(file, c.short, 'working copy'));
  });

  reg('iecode.compareCommits', async arg => {
    const file = targetFile(arg);
    const root = file && await needRepo(file);
    if (!file || !root) return;
    const older = await pickCommit(root, file, 'Compare: older version');
    if (!older) return;
    const newer = await pickCommit(root, file, `Compare ${older.short} with: newer version`);
    if (newer) await vscode.commands.executeCommand('vscode.diff', revUri(file, older.hash, older.short), revUri(file, newer.hash, newer.short), title(file, older.short, newer.short));
  });

  let selected: string | undefined;
  reg('iecode.selectForCompare', async arg => {
    selected = targetFile(arg);
    await vscode.commands.executeCommand('setContext', 'iecode.compareSelected', !!selected);
  });
  reg('iecode.compareWithSelected', async arg => {
    const file = targetFile(arg);
    if (!file) return;
    let other = selected;
    if (!other) {
      const pick = await vscode.window.showOpenDialog({ title: 'Compare with (ST)', filters: { 'TwinCAT objects': ['TcPOU', 'TcDUT', 'TcGVL', 'TcIO'] } });
      other = pick?.[0]?.fsPath;
    }
    if (!other) return;
    await vscode.commands.executeCommand('vscode.diff', viewUri(other), viewUri(file),
      `${path.basename(other)} ↔ ${path.basename(file)} (ST)`);
  });

  reg('iecode.setupGitDiff', async arg => {
    const folder = targetFile(arg) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const root = folder && await needRepo(folder);
    if (!root) return;
    const ok = await vscode.window.showInformationMessage(
      `Show TwinCAT objects as ST in git diff / git log -p for ${path.basename(root)}? This adds lines to .gitattributes and sets diff.iecode.textconv in the repository's git config.`,
      { modal: true }, 'Set up');
    if (ok !== 'Set up') return;
    const cli = path.join(ctx.extensionPath, 'out', 'src', 'cli.js');
    await config(root, 'diff.iecode.textconv', `node "${cli}" decode`);
    const attrs = path.join(root, '.gitattributes');
    const existing = await fs.readFile(attrs, 'utf8').catch(() => '');
    const wanted = ['*.TcPOU', '*.TcDUT', '*.TcGVL', '*.TcIO'].filter(p => !new RegExp(`^${p.replace('.', '\\.').replace('*', '\\*')}\\s.*diff=iecode`, 'm').test(existing));
    if (wanted.length) {
      const block = '# IECode: show TwinCAT objects as Structured Text in git diff\n' + wanted.map(p => `${p} diff=iecode`).join('\n') + '\n';
      const sep = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      await fs.writeFile(attrs, existing + sep + block, 'utf8');
    }
    vscode.window.showInformationMessage('IECode: git diff now shows ST for TwinCAT objects. The textconv setting is local to this clone; commit .gitattributes to share the pattern.');
  });
}
