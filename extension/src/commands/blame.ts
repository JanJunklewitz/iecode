// git blame per method in the ST view: a CodeLens above every section and a hover per line.
// Both read the file on disk, so a dirty `iecode:` document (different line numbers) shows neither.

import * as vscode from 'vscode';
import { LineBlame, blameSections, lensText, makeRefine } from '../core/blame';
import { blame, repoRoot, runGit } from '../core/git';
import { SectionSpan, spansOf, xmlLineOfViewLine } from '../core/objectSpans';

const SCHEME = 'iecode';
const MAX_VIEW_LINES = 20_000;
const SETTING = 'blame.enabled';

interface FileData { key: string; root: string; spans: SectionSpan[]; raw: LineBlame[] }

const enabled = () => vscode.workspace.getConfiguration('iecode').get<boolean>(SETTING, false);

export function registerBlame(ctx: vscode.ExtensionContext): void {
  const cache = new Map<string, FileData>();
  const changed = new vscode.EventEmitter<void>();
  const lensSection = new WeakMap<vscode.CodeLens, { doc: vscode.TextDocument; key: string }>();
  let timeoutNoted = false;

  const drop = () => { cache.clear(); changed.fire(); };

  /** Spans and raw blame of the file behind a view document; undefined when blame is off, impossible or unusable. */
  async function dataOf(doc: vscode.TextDocument): Promise<FileData | undefined> {
    if (!enabled() || doc.isDirty || doc.lineCount > MAX_VIEW_LINES) return undefined;
    const file = doc.uri.with({ scheme: 'file' });
    const root = await repoRoot(file.fsPath);
    if (!root) return undefined;
    let mtime = 0;
    try { mtime = (await vscode.workspace.fs.stat(file)).mtime; } catch { return undefined; }
    let head = '';
    try { head = (await runGit(root, ['rev-parse', 'HEAD'])).trim(); } catch { /* no commit yet: everything is uncommitted */ }
    const key = `${head}|${mtime}`;
    const hit = cache.get(file.fsPath);
    if (hit?.key === key) return hit;
    try {
      const xml = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
      const spans = spansOf(xml);               // throws for a file in a merge conflict
      const raw = await blame(root, file.fsPath);
      if (!raw.length) return undefined;        // untracked
      const data = { key, root, spans, raw };
      cache.set(file.fsPath, data);
      return data;
    } catch (e) {
      if ((e as { timedOut?: boolean }).timedOut && !timeoutNoted) {
        timeoutNoted = true;
        vscode.window.setStatusBarMessage('IECode: git blame timed out, no blame shown for this file', 8000);
      }
      return undefined;
    }
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(doc) {
      const data = await dataOf(doc);
      if (!data) return [];
      return data.spans.map(s => {
        const line = s.header ?? 0;
        const lens = new vscode.CodeLens(new vscode.Range(line, 0, line, 0));
        lensSection.set(lens, { doc, key: s.key });
        return lens;
      });
    },
    async resolveCodeLens(lens) {
      const ref = lensSection.get(lens);
      const data = ref && await dataOf(ref.doc);
      const span = data?.spans.find(s => s.key === ref!.key);
      if (!data || !span) return lens;
      const [b] = await blameSections([span], data.raw, makeRefine(data.root));
      if (!b) return lens;
      lens.command = b.last.uncommitted
        ? { title: lensText(b, Date.now() / 1000), command: '' }
        : { title: lensText(b, Date.now() / 1000), command: 'iecode.blame.copyHash', arguments: [b.last.commit], tooltip: `${b.last.commit}\nClick to copy the commit hash` };
      return lens;
    },
  };

  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const data = await dataOf(doc);
      if (!data) return undefined;
      const hit = xmlLineOfViewLine(data.spans, pos.line);
      if (!hit || hit.xmlLine === undefined) return undefined;
      const [b] = await blameSections([hit.span], data.raw, makeRefine(data.root));
      const line = b?.lines[pos.line - hit.span.viewFirst];
      if (!line) return undefined;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(line.uncommitted
        ? '**Not committed yet**'
        : `**${esc(line.author)}**, ${new Date(line.time * 1000).toLocaleString()}\n\n${esc(line.summary)}\n\n\`${line.commit.slice(0, 7)}\``);
      return new vscode.Hover(md);
    },
  };

  ctx.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, lenses),
    vscode.languages.registerHoverProvider({ scheme: SCHEME }, hover),
    vscode.commands.registerCommand('iecode.toggleBlame', () =>
      vscode.workspace.getConfiguration('iecode').update(SETTING, !enabled(), vscode.ConfigurationTarget.Global)),
    vscode.commands.registerCommand('iecode.blame.copyHash', (hash: string) => vscode.env.clipboard.writeText(hash)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(`iecode.${SETTING}`)) drop(); }),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === SCHEME) drop(); }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
  ctx.subscriptions.push(watcher, watcher.onDidChange(drop), watcher.onDidCreate(drop), watcher.onDidDelete(drop));
}

/** Markdown-safe text for a commit summary or an author name. */
const esc = (s: string) => s.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, '\\$&');
