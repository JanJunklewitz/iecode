// Compare TwinCAT objects as plain ST (no XML): with the git HEAD, an earlier commit, two commits,
// or another file. Git can also be set up to show ST in `git diff` (textconv).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { decode } from '../model';
import { parseVisu, visuToText } from '../core/tcvis';
import { isEncrypted } from '../core/projects';
import { config, getConfig, log, repoRoot, show } from '../core/git';

export const REV_SCHEME = 'iecode-rev';
export const SRC_SCHEME = 'iecode-src';
const EXT_RE = /\.(TcPOU|TcDUT|TcGVL|TcIO|TcVIS)$/i;
/** Visualizations compare as their YAML summary (read-only), objects as ST. */
const VIS_RE = /\.TcVIS$/i;
const OWN_SCHEMES = ['iecode', REV_SCHEME, SRC_SCHEME];

/** iecode-rev:/path/X.TcPOU?ref=<commit> shows the ST view of the file at that commit. */
const revUri = (file: string, ref: string, label: string) =>
  vscode.Uri.file(file).with({ scheme: REV_SCHEME, query: new URLSearchParams({ ref, label }).toString() });
const viewUri = (file: string) => vscode.Uri.file(file).with({ scheme: 'iecode' });
/** iecode-src:/path/X.TcPOU?src=<uri> shows the ST view of any readable URI (e.g. git: from the Source Control view). */
const srcUri = (src: vscode.Uri) => src.with({ scheme: SRC_SCHEME, query: new URLSearchParams({ src: src.toString() }).toString() });
/** ST side of a diff: the editable view for working-tree objects, a read-only view for everything else. */
const stSide = (u: vscode.Uri) => (u.scheme === 'file' && !VIS_RE.test(u.path) ? viewUri(u.fsPath) : srcUri(u));
/** Working copy side of a compare. */
const workingSide = (file: string) => stSide(vscode.Uri.file(file));

function toView(xml: string, file: string): string {
  if (VIS_RE.test(file)) {
    try { return visuToText(parseVisu(xml)); } catch (e) { return `# ${(e as Error).message}\n`; }
  }
  if (isEncrypted(xml)) return '(* encrypted object – content not available *)\n';
  return decode(xml.replace(/^﻿/, ''));
}
const viewKind = (file: string) => (VIS_RE.test(file) ? 'YAML' : 'ST');

/** The Uri of an explorer / editor argument or a Source Control resource state. */
const argUri = (arg: unknown) => (arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri } | undefined)?.resourceUri);

/** The file a command was invoked on: explorer / editor / Source Control / tree node / active editor. */
function targetFile(arg: unknown): string | undefined {
  const fromUri = (u: vscode.Uri) => (EXT_RE.test(u.path) ? u.fsPath : undefined);
  const uri = argUri(arg);
  if (uri) return fromUri(uri);
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

/**
 * Copy of the compiled CLI outside the versioned extension folder, so the git config written by
 * setupGitDiff stays valid after an extension update. Refreshed on activation once it exists, but only
 * when the extension version changed: a running `git diff` in a terminal reads it while other windows start.
 */
const cliDir = (ctx: vscode.ExtensionContext) => path.join(ctx.globalStorageUri.fsPath, 'cli');
async function installCli(ctx: vscode.ExtensionContext, force: boolean): Promise<string> {
  const dir = cliDir(ctx);
  const cli = path.join(dir, 'cli.js').split(path.sep).join('/');
  const version = String(ctx.extension.packageJSON.version);
  const stamp = path.join(dir, '.version');
  if (!force && await fs.readFile(stamp, 'utf8').catch(() => '') === version) return cli;
  // copy next to it first, so the old copy is missing only for the moment of the swap
  const tmp = `${dir}.${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.cp(path.join(ctx.extensionPath, 'out', 'src'), tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, '.version'), version, 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmp, dir);
  return cli;
}

/** A program on PATH (with PATHEXT on Windows), or undefined. */
async function onPath(name: string): Promise<string | undefined> {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (await fs.stat(file).then(s => s.isFile(), () => false)) return file;
    }
  }
  return undefined;
}

export function register(ctx: vscode.ExtensionContext) {
  void fs.access(cliDir(ctx)).then(() => installCli(ctx, false), () => undefined).catch(() => undefined);
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, {
    async provideTextDocumentContent(uri) {
      const ref = new URLSearchParams(uri.query).get('ref') ?? 'HEAD';
      const root = await repoRoot(uri.fsPath);
      if (!root) return '(* not in a git repository *)\n';
      const xml = await show(root, ref, uri.fsPath);
      if (xml === undefined) return VIS_RE.test(uri.path) ? `# ${path.basename(uri.fsPath)} doesn't exist in ${ref}\n` : `(* ${path.basename(uri.fsPath)} doesn't exist in ${ref} *)\n`;
      return toView(xml, uri.path);
    },
  }));
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SRC_SCHEME, {
    async provideTextDocumentContent(uri) {
      const src = vscode.Uri.parse(new URLSearchParams(uri.query).get('src') ?? '');
      // workspace.fs reads the bytes as UTF-8 regardless of files.encoding; some schemes only have a
      // content provider (e.g. git-graph: from the Git Graph extension), so fall back to a text document
      const xml = await vscode.workspace.fs.readFile(src).then(
        bytes => Buffer.from(bytes).toString('utf8'),
        async () => (await vscode.workspace.openTextDocument(src)).getText());
      // git: returns empty content for a side where the file doesn't exist (added / deleted)
      return xml.trim() === '' ? '' : toView(xml, src.path);
    },
  }));

  // Source Control view (and any other diff of two object files): show both sides as ST instead of XML.
  ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(async e => {
    if (!vscode.workspace.getConfiguration('iecode').get<boolean>('openAsST', true)) return;
    for (const tab of e.opened) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff)) continue;
      const { original, modified } = input;
      if (!EXT_RE.test(original.path) || !EXT_RE.test(modified.path)) continue;
      if (OWN_SCHEMES.includes(original.scheme) && OWN_SCHEMES.includes(modified.scheme)) continue;
      try {
        await vscode.commands.executeCommand('vscode.diff', stSide(original), stSide(modified), `${tab.label} (${viewKind(modified.path)})`,
          { viewColumn: tab.group.viewColumn, preview: tab.isPreview });
      } catch (err) {
        vscode.window.showWarningMessage(`IECode: cannot show the diff as ST: ${(err as Error).message}`);
        continue;
      }
      // a preview tab may already have been replaced by the ST diff
      const same = (t: vscode.Tab) => t.input instanceof vscode.TabInputTextDiff
        && t.input.original.toString() === original.toString() && t.input.modified.toString() === modified.toString();
      const still = tab.group.tabs.find(same);
      if (still) await vscode.window.tabGroups.close(still);
    }
  }));

  const title = (file: string, left: string, right: string) => `${path.basename(file).replace(EXT_RE, '')} (${viewKind(file)}): ${left} ↔ ${right}`;
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
    await vscode.commands.executeCommand('vscode.diff', revUri(file, 'HEAD', 'HEAD'), workingSide(file), title(file, 'HEAD', 'working copy'));
  });

  reg('iecode.compareWithCommit', async arg => {
    const file = targetFile(arg);
    const root = file && await needRepo(file);
    if (!file || !root) return;
    const c = await pickCommit(root, file, 'Compare the working copy with …');
    if (c) await vscode.commands.executeCommand('vscode.diff', revUri(file, c.hash, c.short), workingSide(file), title(file, c.short, 'working copy'));
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

  // Source Control submenu: VS Code can't filter that menu by file type (it is cached per resource state),
  // so its entries pick the compare that fits the clicked file: ST for objects, IO links as YAML for .tsproj / .xti.
  const scm = (id: string, st: string, io: string) => reg(id, async arg => {
    const uri = argUri(arg) ?? vscode.window.activeTextEditor?.document.uri;
    if (uri && EXT_RE.test(uri.path)) return vscode.commands.executeCommand(st, uri);
    if (uri && /\.(tsproj|xti)$/i.test(uri.path)) return vscode.commands.executeCommand(io, uri);
    vscode.window.showInformationMessage('IECode: compare works on TwinCAT objects (.TcPOU, .TcDUT, .TcGVL, .TcIO), visualizations (.TcVIS) and system project files (.tsproj, .xti).');
  });
  scm('iecode.scmCompareWithHead', 'iecode.compareWithHead', 'iecode.ioLinksDiff');
  scm('iecode.scmCompareWithCommit', 'iecode.compareWithCommit', 'iecode.ioLinksDiffCommit');

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
      const pick = await vscode.window.showOpenDialog({ title: 'Compare with', filters: { 'TwinCAT objects': ['TcPOU', 'TcDUT', 'TcGVL', 'TcIO', 'TcVIS'] } });
      other = pick?.[0]?.fsPath;
    }
    if (!other) return;
    await vscode.commands.executeCommand('vscode.diff', workingSide(other), workingSide(file),
      `${path.basename(other)} ↔ ${path.basename(file)} (${viewKind(file)})`);
  });

  reg('iecode.setupGitDiff', async arg => {
    const folder = targetFile(arg) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const root = folder && await needRepo(folder);
    if (!root) return;
    const ok = await vscode.window.showInformationMessage(
      `Show TwinCAT objects as ST in git diff / git log -p / git difftool for ${path.basename(root)}? This adds lines to .gitattributes and sets diff.iecode.textconv and difftool.iecode.cmd in the repository's git config.`,
      { modal: true }, 'Set up');
    if (ok !== 'Set up') return;
    const cli = await installCli(ctx, true);
    await config(root, 'diff.iecode.textconv', `node "${cli}" decode`);
    // git difftool ignores textconv: wrap the configured graphical diff tool (e.g. KDiff3) instead,
    // found the way git difftool finds it (merge tool settings as fallback, then the tool on PATH)
    let tool: string | undefined;
    for (const key of ['diff.guitool', 'merge.guitool', 'diff.tool', 'merge.tool']) {
      const t = await getConfig(root, key);
      if (t && t !== 'iecode') { tool = t; break; }
    }
    const viewer = tool && (await getConfig(root, `difftool.${tool}.path`) ?? await getConfig(root, `mergetool.${tool}.path`) ?? await onPath(tool));
    if (viewer) await config(root, 'difftool.iecode.cmd', `node "${cli}" difftool "${viewer.replace(/\\/g, '/')}" "$LOCAL" "$REMOTE"`);
    const attrs = path.join(root, '.gitattributes');
    const existing = await fs.readFile(attrs, 'utf8').catch(() => '');
    const wanted = ['*.TcPOU', '*.TcDUT', '*.TcGVL', '*.TcIO', '*.TcVIS'].filter(p => !new RegExp(`^${p.replace('.', '\\.').replace('*', '\\*')}\\s.*diff=iecode`, 'm').test(existing));
    if (wanted.length) {
      const block = '# IECode: show TwinCAT objects as Structured Text in git diff\n' + wanted.map(p => `${p} diff=iecode`).join('\n') + '\n';
      const sep = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      await fs.writeFile(attrs, existing + sep + block, 'utf8');
    }
    vscode.window.showInformationMessage('IECode: git diff now shows ST for TwinCAT objects'
      + (viewer ? `; git difftool -t iecode shows ST in ${tool}` : '; no graphical diff tool is configured or on PATH, so git difftool still shows XML')
      + '. The git config is local to this clone; commit .gitattributes to share the pattern.');
  });
}
