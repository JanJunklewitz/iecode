// ADS Watch view: watched PLC variables with their live values from the `iecode ads serve` host. Symbols come
// from the build output (.tmc), the ST editor or free text; writes are always confirmed, also on `local` (C0).
// Entries the AI added (LM tools) carry a sparkle icon.

import * as vscode from 'vscode';
import { WorkspaceState } from '../state';
import { fromBuild } from '../core/adsinterface';
import { AdsHost, StartError, WriteNotSent } from '../ads/host';
import { MAX_WATCHED, WatchItem, symbolAt, watchEdit, watchRename } from '../core/adswatch';
import { aiWritesSetting } from '../ads/aiSettings';
import { writeAdsSetting } from '../ads/settingsWrite';

const REFRESH_MS = 250;
const NAME = /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/;

const validTarget = (v: string) => /^local$/i.test(v.trim()) || /^(\d{1,3}\.){5}\d{1,3}$/.test(v.trim());

type Pick =vscode.QuickPickItem & { symbol: string };

/** Multi-select list of known symbols; the typed filter text is offered as one more entry, so any name can be watched in a single step. */
function pickNames(picks: Pick[], placeHolder: string): Promise<string[] | undefined> {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<Pick>();
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.placeholder = placeHolder;
    qp.items = picks;
    qp.onDidChangeValue(value => {
      const typed = value.split(',').map(s => s.trim()).filter(Boolean);
      const known = new Set(picks.map(p => p.symbol.toLowerCase()));
      const extra: Pick[] = typed.length && !typed.every(t => known.has(t.toLowerCase()))
        ? [{ label: `Watch ${typed.join(', ')}`, symbol: typed.join(','), alwaysShow: true }]
        : [];
      const keep = qp.selectedItems;
      qp.items = [...extra, ...picks];
      qp.selectedItems = keep.filter(k => picks.includes(k));
    });
    qp.onDidAccept(() => {
      const names = qp.selectedItems.flatMap(i => i.symbol.split(',')).filter(Boolean);
      // Enter without a tick takes the typed name
      const typed = qp.value.split(',').map(s => s.trim()).filter(Boolean);
      resolve(names.length ? names : typed);
      qp.hide();
    });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
}

class WatchTree implements vscode.TreeDataProvider<WatchItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private ai = new Set<string>();

  constructor(private readonly host: AdsHost) {}

  refresh() { this.changed.fire(); }

  getChildren(n?: WatchItem): WatchItem[] {
    if (n) return [];
    this.ai = new Set(this.host.entries().filter(e => e.ai).map(e => e.symbol.toLowerCase()));
    return this.host.items();
  }

  getTreeItem(n: WatchItem): vscode.TreeItem {
    const it = new vscode.TreeItem(n.symbol, vscode.TreeItemCollapsibleState.None);
    const value = this.host.value(n.symbol);
    it.description = n.error ? `⚠ ${n.error}` : value === null ? '⚠ read error' : value ?? '';
    const ai = this.ai.has(n.symbol.toLowerCase());
    // the row is cut off in a narrow view, so the tooltip carries the full name and the value
    it.tooltip = [n.symbol, n.type && `Type: ${n.type}`, n.error ? `Error: ${n.error}` : value === null ? 'Read error' : value !== undefined ? `Value: ${value}` : '', ai ? 'Added by AI' : ''].filter(Boolean).join('\n');
    it.iconPath = new vscode.ThemeIcon(n.error ? 'warning' : ai ? 'sparkle' : 'symbol-variable');
    it.contextValue = 'adsWatch.item';
    it.id = `adsWatch:${n.symbol}`;
    return it;
  }
}

/** Errors of a failed host start were already shown by the host. */
function showError(e: unknown) {
  if (e instanceof StartError || (e instanceof WriteNotSent && e.alreadyShown)) return;
  vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
}

export function registerAdsWatch(ctx: vscode.ExtensionContext, state: WorkspaceState, mcp?: { serving(): boolean; onState: vscode.Event<void> }) {
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
  // the target is always shown (a write goes there); auto-approved AI writes must never be on unnoticed
  const showAiWrites = () => { view.description = [host.target(), mcp?.serving() ? 'MCP: on' : undefined, aiWritesSetting() === 'auto' ? 'AI writes: auto' : undefined].filter(Boolean).join(' · '); };
  showAiWrites();

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
    ...(mcp ? [mcp.onState(showAiWrites)] : []),
    view.onDidChangeVisibility(updateLease),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.ads.aiWrites') || e.affectsConfiguration('iecode.ads.target') || e.affectsConfiguration('iecode.ads.port')) showAiWrites(); }),
    new vscode.Disposable(() => { clearTimeout(timer); lease?.dispose(); }),
  );

  const add = async (symbols: string[]) => {
    try {
      // symbols the AI added become the user's when the user adds them
      await host.setEntries(watchEdit(host.entries(), symbols));
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
    const picks: Pick[] = [];
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
      : 'Variables to watch (from the build output)') + `; ${room} more fit. Type a name to watch any other variable`;
    const names = await pickNames(picks, placeHolder);
    if (names?.length) await add(names);
  });

  reg('iecode.adsTarget', async () => {
    const cfg = vscode.workspace.getConfiguration('iecode.ads');
    const typed = await vscode.window.showInputBox({
      prompt: 'ADS target: "local" or the AMS NetId of the PLC (six numbers). Changing it reconnects.',
      value: cfg.get<string>('target', 'local'),
      placeHolder: 'local, 172.20.30.60.1.1',
      validateInput: v => validTarget(v) ? undefined : 'Use "local" or six numbers separated by dots, e.g. 172.20.30.60.1.1',
    });
    if (typed === undefined) return;
    try { await writeAdsSetting('target', typed.trim()); } catch (e) { showError(e); }
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
      if (back.value === null) vscode.window.showWarningMessage(`IECode: ${symbol} was written, but the read-back failed: ${back.readBackError ?? 'unknown error'}`);
      else vscode.window.setStatusBarMessage(`IECode: ${symbol} = ${back.value}`, 5000);
      schedule();
    } catch (e) {
      showError(e);
    }
  });

  reg('iecode.adsWatchCopyPath', async (n?: WatchItem, all?: WatchItem[]) => {
    const symbols = selected(n, all);
    if (symbols.length) await vscode.env.clipboard.writeText(symbols.join('\n'));
  });

  reg('iecode.adsWatchEdit', async (n?: WatchItem) => {
    const symbol = n?.symbol ?? view.selection[0]?.symbol;
    if (!symbol) return;
    const typed = await vscode.window.showInputBox({ prompt: 'ADS name to watch (full path, e.g. MAIN.fbMotor.bEnable)', value: symbol, validateInput: v => (v.trim() ? undefined : 'Enter a name') });
    if (typed === undefined || typed.trim() === symbol) return;
    try { await host.setEntries(watchRename(host.entries(), symbol, typed)); } catch (e) { showError(e); }
  });

  reg('iecode.adsWatchCopy', async (n?: WatchItem) => {
    const symbol = n?.symbol ?? view.selection[0]?.symbol;
    if (!symbol) return;
    await vscode.env.clipboard.writeText(host.value(symbol) ?? '');
  });
}
