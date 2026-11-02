// ADS Watch view: watched PLC variables with their live values from the `iecode ads serve` host. Symbols come
// from the build output (.tmc), the ST editor or free text; writes are always confirmed, also on `local` (C0).

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { fromBuild } from '../core/adsinterface';
import { AdsHost, StartError } from '../ads/host';
import { MAX_WATCHED, WatchItem, symbolAt } from '../core/adswatch';

const REFRESH_MS = 250;
const ENTER = 'Enter a name…';
const NAME = /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/;

class WatchTree implements vscode.TreeDataProvider<WatchItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: AdsHost) {}

  refresh() { this.changed.fire(); }

  getChildren(n?: WatchItem): WatchItem[] { return n ? [] : this.host.items(); }

  getTreeItem(n: WatchItem): vscode.TreeItem {
    const it = new vscode.TreeItem(n.symbol, vscode.TreeItemCollapsibleState.None);
    const value = this.host.value(n.symbol);
    it.description = n.error ? `⚠ ${n.error}` : value === null ? '⚠ read error' : value ?? '';
    it.tooltip = n.type || undefined;
    it.iconPath = new vscode.ThemeIcon(n.error ? 'warning' : 'symbol-variable');
    it.contextValue = 'adsWatch.item';
    it.id = `adsWatch:${n.symbol}`;
    return it;
  }
}

/** Errors of a failed host start were already shown by the host. */
function showError(e: unknown) {
  if (e instanceof StartError) return;
  vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
}

export function registerAdsWatch(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const host = AdsHost.get(ctx);
  const tree = new WatchTree(host);
  const view = vscode.window.createTreeView('iecode.adsWatch', { treeDataProvider: tree, canSelectMany: true });
  ctx.subscriptions.push(view);

  // at most 4 refreshes per second, however fast samples arrive
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; tree.refresh(); }, REFRESH_MS); };
  const showState = () => {
    const s = host.state();
    view.message = !s.connected && s.error ? `Disconnected: ${s.error}` : undefined;
  };
  showState();

  // the host runs while the view is visible with a non-empty list; a saved list alone does not connect (O11)
  let lease: vscode.Disposable | undefined;
  const updateLease = () => {
    const want = view.visible && host.watched().length > 0;
    if (want && !lease) lease = host.use();
    else if (!want && lease) { lease.dispose(); lease = undefined; }
  };
  updateLease();

  ctx.subscriptions.push(
    host.onSamples(schedule),
    host.onItems(() => { schedule(); updateLease(); }),
    host.onState(() => { showState(); schedule(); }),
    view.onDidChangeVisibility(updateLease),
    new vscode.Disposable(() => { clearTimeout(timer); lease?.dispose(); }),
  );

  const add = async (symbols: string[]) => {
    try {
      await host.setWatched([...host.watched(), ...symbols]);
    } catch (e) {
      showError(e);
    }
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const selected = (n?: WatchItem, all?: WatchItem[]) => (all?.length ? all : n ? [n] : [...view.selection]).map(i => i.symbol);

  reg('iecode.adsWatchAdd', async () => {
    const room = MAX_WATCHED - host.watched().length;
    if (room <= 0) return void vscode.window.showWarningMessage(`IECode: the ADS watch already has ${MAX_WATCHED} variables, the most it can hold. Remove some first.`);
    const watched = new Set(host.watched().map(s => s.toLowerCase()));
    const units = state.current.units.filter(u => !u.plc.isLibrary);
    const picks: (vscode.QuickPickItem & { symbol?: string })[] = [{ label: ENTER, alwaysShow: true }];
    const missing: string[] = [];
    for (const u of units) {
      try {
        const ads = await fromBuild(u.plc, true);
        for (const s of ads.symbols) {
          if (watched.has(s.name.toLowerCase())) continue;
          picks.push({ label: s.name, description: units.length > 1 ? `${s.type} · ${u.id}` : s.type, symbol: s.name });
        }
      } catch {
        missing.push(u.plc.name);
      }
    }
    const placeHolder = (missing.length
      ? `Variables to watch (not built, so not listed: ${missing.join(', ')})`
      : 'Variables to watch (from the build output)') + `; ${room} more fit`;
    const chosen = await vscode.window.showQuickPick(picks, { canPickMany: true, matchOnDescription: true, placeHolder });
    if (!chosen?.length) return;
    const names = chosen.filter(c => c.symbol).map(c => c.symbol!);
    if (chosen.some(c => c.label === ENTER)) {
      const typed = await vscode.window.showInputBox({ prompt: 'ADS names to watch, separated by commas', placeHolder: 'MAIN.bStart, GVL.nCount' });
      if (typed) names.push(...typed.split(',').map(s => s.trim()).filter(Boolean));
    }
    if (names.length) await add(names);
  });

  reg('iecode.adsWatchAddFromEditor', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const range = ed.selection.isEmpty ? ed.document.getWordRangeAtPosition(ed.selection.active, NAME) : ed.selection;
    const word = range ? ed.document.getText(range).trim() : '';
    let { name, qualified } = symbolAt(ed.document.getText(), word, ed.document.uri.path);
    if (!qualified) {
      const typed = await vscode.window.showInputBox({ prompt: 'ADS name to watch (e.g. MAIN.fbMotor.bEnable)', value: name });
      if (!typed?.trim()) return;
      name = typed.trim();
    }
    await add([name]);
    await vscode.commands.executeCommand('iecode.adsWatch.focus');
  });

  reg('iecode.adsWatchRemove', async (n?: WatchItem, all?: WatchItem[]) => {
    const drop = new Set(selected(n, all).map(s => s.toLowerCase()));
    if (!drop.size) return;
    try { await host.setWatched(host.watched().filter(s => !drop.has(s.toLowerCase()))); } catch (e) { showError(e); }
  });

  reg('iecode.adsWatchClear', async () => {
    try { await host.setWatched([]); } catch (e) { showError(e); }
  });

  reg('iecode.adsWatchWrite', async (n?: WatchItem) => {
    const symbol = n?.symbol ?? view.selection[0]?.symbol;
    if (!symbol) return;
    const current = host.value(symbol);
    const value = await vscode.window.showInputBox({ prompt: `New value for ${symbol}`, value: current ?? '' });
    if (value === undefined) return;
    // also on `local`: on a machine PC the local runtime drives the real machine (C0)
    const ok = await vscode.window.showWarningMessage(`Write ${symbol} := ${value} on ${host.target()}?`, { modal: true }, 'Write');
    if (ok !== 'Write') return;
    try {
      const back = await host.write(symbol, value);
      vscode.window.setStatusBarMessage(`IECode: ${symbol} = ${back}`, 5000);
      schedule();
    } catch (e) {
      showError(e);
    }
  });

  reg('iecode.adsWatchCopy', async (n?: WatchItem) => {
    const symbol = n?.symbol ?? view.selection[0]?.symbol;
    if (!symbol) return;
    await vscode.env.clipboard.writeText(host.value(symbol) ?? '');
  });
}
