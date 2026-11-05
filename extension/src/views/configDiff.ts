// "Config Changes" panel: the changes of an .xti file between two versions, grouped by category, with
// checkboxes that hide categories and noise kinds (the setting iecode.configDiff.hidden). Both versions can
// also be opened as YAML or as raw XML in VS Code's diff editor.

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { unescapeKey } from '../core/configmodel';
import { ConfigChange, DEFAULT_HIDDEN, Filter, configToYaml, diffConfig, groupChanges } from '../core/configdiff';
import { configAt } from '../core/confighistory';
import { log, repoRoot } from '../core/git';
import { rawUri } from '../commands/compare';
import { html } from './configDiffHtml';

type Msg =
  | { type: 'ready' }
  | { type: 'load' | 'yaml' | 'raw'; file: string; left: string; right: string; leftLabel: string; rightLabel: string }
  | { type: 'filter'; hidden: Filter[] }
  | { type: 'ioLinks'; file: string };

const WORKING = '';               // ref value for the working copy
const YAML_SCHEME = 'iecode-config';
const MAX_VALUE = 2000;           // longer values are cut in the message to the webview (the YAML has them all)
const NOT_XTI = 'IECode: select an .xti file to compare its configuration.';

let panel: vscode.WebviewPanel | undefined;
let current: { file: string; left: string; right: string } | undefined;
const yamlChanged = new vscode.EventEmitter<vscode.Uri>();
/** YAML documents handed out so far, to re-render them when the filter changes. */
const yamlUris = new Map<string, vscode.Uri>();

const hiddenSet = () => new Set<Filter>(vscode.workspace.getConfiguration('iecode.configDiff').get<Filter[]>('hidden', DEFAULT_HIDDEN));
const ref = (r: string) => (r === WORKING ? undefined : r);
/** Label without the commit subject: "HEAD", "Working copy" or the short hash. */
const shortLabel = (r: string, label: string) => (r === WORKING || r === 'HEAD' ? label : label.split(' · ')[0]);

/** iecode-config:/<file> config (<label>).yaml?file=…&ref=… shows the visible entries of one version as YAML. */
function yamlUri(file: string, r: string, label: string): vscode.Uri {
  const uri = vscode.Uri.from({
    scheme: YAML_SCHEME, path: `/${path.basename(file)} config (${label.replace(/[\\/]/g, '_')}).yaml`,
    query: new URLSearchParams({ file, ref: r, label }).toString(),
  });
  yamlUris.set(uri.toString(), uri);
  return uri;
}

async function openYamlDiff(file: string, left: string, right: string, leftLabel: string, rightLabel: string) {
  const a = yamlUri(file, left, leftLabel), b = yamlUri(file, right, rightLabel);
  yamlChanged.fire(a);
  yamlChanged.fire(b);
  if (left === right) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(b), { preview: false });
  else await vscode.commands.executeCommand('vscode.diff', a, b, `${path.basename(file)} config: ${leftLabel} ↔ ${rightLabel}`, { preview: false });
}

const cut = (s: string | undefined) => (s !== undefined && s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + '…' : s);
const pick = (c: ConfigChange) => ({ kind: c.kind, key: unescapeKey(c.key.startsWith(c.category + '/') ? c.key.slice(c.category.length + 1) : c.key), before: cut(c.before), after: cut(c.after) });

async function versions(file: string) {
  const root = await repoRoot(file);
  const commits = root ? await log(root, [file], 100) : [];
  return [{ ref: WORKING, label: 'Working copy' }, ...(root ? [{ ref: 'HEAD', label: 'HEAD' }] : []),
    ...commits.map(c => ({ ref: c.hash, label: `${c.short} · ${c.date} · ${c.subject}` }))];
}

async function showPanel(ctx: vscode.ExtensionContext, file: string, left: string, right: string) {
  current = { file, left, right };
  const init = async () => panel?.webview.postMessage({
    type: 'init', file, name: path.basename(file), versions: await versions(file), left: current!.left, right: current!.right, hidden: [...hiddenSet()],
  });
  if (panel) { panel.reveal(); await init(); return; }
  panel = vscode.window.createWebviewPanel('iecode.configDiff', 'IECode: Config Changes', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = html(randomBytes(16).toString('hex'), panel.webview.cspSource);
  const post = (m: unknown) => panel?.webview.postMessage(m);

  // last comparison, so a filter change only recomputes the groups
  let last: { changes: ConfigChange[]; warnings: string[] } | undefined;
  const send = () => {
    if (!last) return;
    const hidden = hiddenSet();
    const g = groupChanges(last.changes, hidden);
    post({
      type: 'result', hidden: [...hidden], hiddenBy: g.hiddenBy, links: g.links, warnings: last.warnings,
      visible: g.groups.reduce((n, x) => n + x.total, 0), hiddenTotal: g.groups.reduce((n, x) => n + x.hidden, 0),
      groups: g.groups.map(x => ({ category: x.category, total: x.total, hidden: x.hidden, shown: x.shown.map(pick) })),
    });
  };
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(ev => {
    if (!ev.affectsConfiguration('iecode.configDiff.hidden')) return;
    send();
    for (const uri of yamlUris.values()) yamlChanged.fire(uri);
  }));

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    try {
      if (m.type === 'ready') await init();
      else if (m.type === 'load') {
        current = { file: m.file, left: m.left, right: m.right };
        const [a, b] = await Promise.all([configAt(m.file, ref(m.left)), configAt(m.file, ref(m.right))]);
        const name = path.basename(m.file);
        last = {
          changes: diffConfig(a.entries, b.entries),
          warnings: [[a, m.leftLabel, m.left] as const, [b, m.rightLabel, m.right] as const]
            .filter(([v]) => v.missing).map(([, label, r]) => `${name} does not exist in ${shortLabel(r, label)}`),
        };
        send();
      } else if (m.type === 'yaml') await openYamlDiff(m.file, m.left, m.right, shortLabel(m.left, m.leftLabel), shortLabel(m.right, m.rightLabel));
      else if (m.type === 'raw') {
        await vscode.commands.executeCommand('vscode.diff', rawUri(m.file, ref(m.left)), rawUri(m.file, ref(m.right)),
          `${path.basename(m.file)} (XML): ${shortLabel(m.left, m.leftLabel)} ↔ ${shortLabel(m.right, m.rightLabel)}`, { preview: false });
      } else if (m.type === 'filter') await vscode.workspace.getConfiguration('iecode.configDiff').update('hidden', m.hidden, vscode.ConfigurationTarget.Global);
      else if (m.type === 'ioLinks') await vscode.commands.executeCommand('iecode.ioLinksDiff', vscode.Uri.file(m.file));
    } catch (e) {
      post({ type: 'error', message: (e as Error).message });
    }
  }, undefined, ctx.subscriptions);
  panel.onDidDispose(() => { panel = undefined; current = undefined; });
}

/** YAML documents, the Config Changes panel and its commands (explorer / editor / Source Control menus). */
export function registerConfigDiff(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(yamlChanged, vscode.workspace.registerTextDocumentContentProvider(YAML_SCHEME, {
    onDidChange: yamlChanged.event,
    async provideTextDocumentContent(uri) {
      const q = new URLSearchParams(uri.query);
      const file = q.get('file') ?? '', r = q.get('ref') ?? '';
      try {
        const v = await configAt(file, ref(r));
        const header = `# Config of ${path.basename(file)} (${q.get('label')})` + (v.missing ? '\n# the file does not exist in this version' : '')
          + `\n# hidden: ${[...hiddenSet()].join(', ') || 'nothing'} (setting iecode.configDiff.hidden)`;
        return configToYaml(v.entries, hiddenSet(), header);
      } catch (e) {
        return `# ${(e as Error).message}\n`;
      }
    },
  }));

  // explorer / editor title: a Uri; Source Control: a resource state with resourceUri
  const command = (ids: string[], fn: (file: string, root: string) => Promise<unknown>) => {
    const run = async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : (arg as { resourceUri?: vscode.Uri } | undefined)?.resourceUri
        ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file' || !/\.xti$/i.test(uri.fsPath)) { vscode.window.showInformationMessage(NOT_XTI); return; }
      try {
        const root = await repoRoot(uri.fsPath);
        if (!root) { vscode.window.showWarningMessage('IECode: this file is not in a git repository.'); return; }
        await fn(uri.fsPath, root);
      } catch (e) {
        vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
      }
    };
    for (const id of ids) ctx.subscriptions.push(vscode.commands.registerCommand(id, run));
  };

  command(['iecode.configDiff', 'iecode.scmConfigDiff'], (file) => showPanel(ctx, file, 'HEAD', WORKING));
}

