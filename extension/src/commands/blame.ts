// git blame per method in the ST view: a CodeLens above every section and a hover per line.
// Both read the file on disk, so a dirty `iecode:` document (different line numbers) shows neither.

import * as vscode from 'vscode';
import { LineBlame, SectionBlame, blameSections, lensText, makeRefine } from '../core/blame';
import { blame, repoRoot, runGit } from '../core/git';
import { SectionSpan, spansOf, xmlLineOfViewLine } from '../core/objectSpans';

const SCHEME = 'iecode';
const MAX_VIEW_LINES = 20_000;
const SETTING = 'blame.enabled';

interface FileData {
  key: string; root: string; spans: SectionSpan[]; raw: LineBlame[];
  /** Refined blame per section key, shared by all lenses and hovers of the file (refining runs `git log -L`). */
  sections: Map<string, Promise<SectionBlame | undefined>>;
}

const enabled = () => vscode.workspace.getConfiguration('iecode').get<boolean>(SETTING, false);

export function registerBlame(ctx: vscode.ExtensionContext): void {
  // Promises, so parallel callers share one blame run; a failed or empty result is kept too and not retried until the key changes
  const cache = new Map<string, { key: string; data: Promise<FileData | undefined> }>();
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
    if (hit?.key === key) return hit.data;
    const data = load(file, root, key);
    cache.set(file.fsPath, { key, data });
    return data;
  }

  async function load(file: vscode.Uri, root: string, key: string): Promise<FileData | undefined> {
    try {
      const xml = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(file));
      const spans = spansOf(xml);               // throws for a file in a merge conflict
      const raw = await blame(root, file.fsPath);
      if (!raw.length) return undefined;        // untracked
      return { key, root, spans, raw, sections: new Map() };
    } catch (e) {
      if ((e as { timedOut?: boolean }).timedOut && !timeoutNoted) {
        timeoutNoted = true;
        vscode.window.setStatusBarMessage('IECode: git blame timed out, no blame shown for this file', 8000);
      }
      return undefined;
    }
  }

  function sectionOf(data: FileData, span: SectionSpan): Promise<SectionBlame | undefined> {
    let p = data.sections.get(span.key);
    if (!p) {
      p = blameSections([span], data.raw, makeRefine(data.root)).then(r => r[0]);
      data.sections.set(span.key, p);
    }
    return p;
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
      const b = await sectionOf(data, span);
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
      const b = await sectionOf(data, hit.span);
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
    vscode.commands.registerCommand('iecode.toggleBlame', () => {
      const cfg = vscode.workspace.getConfiguration('iecode');
      // write where the effective value lives, otherwise a workspace override hides the change
      const i = cfg.inspect<boolean>(SETTING);
      const target = i?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      return cfg.update(SETTING, !enabled(), target);
    }),
    // a commit from a terminal or another tool changes HEAD without touching a file: look again when the window regains focus
    vscode.window.onDidChangeWindowState(w => { if (w.focused) changed.fire(); }),
    vscode.commands.registerCommand('iecode.blame.copyHash', (hash: string) => vscode.env.clipboard.writeText(hash)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(`iecode.${SETTING}`)) drop(); }),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === SCHEME) drop(); }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{TcPOU,TcDUT,TcGVL,TcIO}');
  ctx.subscriptions.push(watcher, watcher.onDidChange(drop), watcher.onDidCreate(drop), watcher.onDidDelete(drop));
}

/** Markdown-safe text for a commit summary or an author name. */
const esc = (s: string) => s.replace(/[\\`*_{}[\]<>()#+\-.!|]/g, '\\$&');
