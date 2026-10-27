// IO-Link view: the IO-Link masters of the system projects with their ports, the device on each port and the
// port's process data (with the linked variables). A master can be saved as an independent project file (.xti).

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WorkspaceState } from '../state';
import { extractBox, IoLinkEntry, IoLinkMaster, IoLinkPort, IoLinkStructure, readIoLinkStructure } from '../core/iolinkmasters';
import { IoLinkSource, showIoLinkExplorer } from './ioLinkExplorer';

type Project = { tsproj: string; name: string };
export type IoLinkNode =
  | { kind: 'project'; project: Project }
  | { kind: 'master'; project: Project; master: IoLinkMaster }
  | { kind: 'port'; master: IoLinkMaster; port: IoLinkPort }
  | { kind: 'entry'; port: IoLinkPort; entry: IoLinkEntry }
  | { kind: 'message'; text: string; icon: string };

const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);
const hex = (n: number, digits: number) => '0x' + n.toString(16).toUpperCase().padStart(digits, '0');
/** Device path without TIID^ and the master itself: Device 1 (EtherCAT) › TB1.0 (EK1200) › … */
const location = (m: IoLinkMaster) => m.path.split('^').slice(1, -1).join(' › ');

class IoLinkTree implements vscode.TreeDataProvider<IoLinkNode> {
  private readonly changed = new vscode.EventEmitter<IoLinkNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private cache = new Map<string, Promise<IoLinkStructure>>();

  constructor(private readonly state: WorkspaceState) {
    state.onDidChange(() => this.refresh());
  }

  refresh() { this.cache.clear(); this.changed.fire(undefined); }

  projects(): Project[] {
    return this.state.current.solutions.flatMap(s => s.projects.filter(p => !p.plcOnly)).map(p => ({ tsproj: p.file, name: p.name }));
  }

  structure(tsproj: string): Promise<IoLinkStructure> {
    let s = this.cache.get(tsproj);
    if (!s) this.cache.set(tsproj, s = readIoLinkStructure(tsproj, read));
    return s;
  }

  private async masters(project: Project): Promise<IoLinkNode[]> {
    try {
      const s = await this.structure(project.tsproj);
      const nodes: IoLinkNode[] = s.masters.map(master => ({ kind: 'master', project, master }));
      for (const w of s.warnings) nodes.push({ kind: 'message', text: w, icon: 'warning' });
      return nodes.length ? nodes : [{ kind: 'message', text: 'No IO-Link masters', icon: 'info' }];
    } catch (e) {
      return [{ kind: 'message', text: (e as Error).message, icon: 'error' }];
    }
  }

  async getChildren(n?: IoLinkNode): Promise<IoLinkNode[]> {
    if (!n) {
      const ps = this.projects();
      if (ps.length === 1) return this.masters(ps[0]);
      return ps.map(project => ({ kind: 'project', project }));
    }
    switch (n.kind) {
      case 'project': return this.masters(n.project);
      case 'master': return n.master.ports.map(port => ({ kind: 'port', master: n.master, port }));
      case 'port': return n.port.entries.map(entry => ({ kind: 'entry', port: n.port, entry }));
      default: return [];
    }
  }

  getTreeItem(n: IoLinkNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'project': {
        const it = new vscode.TreeItem(n.project.name, C.Expanded);
        it.iconPath = new vscode.ThemeIcon('server-environment');
        it.tooltip = n.project.tsproj;
        it.contextValue = 'iolink.project';
        it.id = `iolink:${n.project.tsproj}`;
        return it;
      }
      case 'master': {
        const m = n.master;
        const it = new vscode.TreeItem(m.name, C.Collapsed);
        it.description = [`${m.ports.filter(p => p.device).length}/${m.ports.length} ports`, m.independent && 'own file'].filter(Boolean).join(' · ');
        it.iconPath = new vscode.ThemeIcon('circuit-board');
        it.tooltip = new vscode.MarkdownString(`**${m.name}**  \n${m.type ?? ''}  \n${location(m)}  \n${m.file}`);
        it.contextValue = m.independent ? 'iolink.master.independent' : 'iolink.master';
        it.id = `iolink:${m.path}`;
        it.command = { command: 'iecode.ioLinkExplorer', title: 'Open in IO-Link Explorer', arguments: [n] };
        return it;
      }
      case 'port': {
        const p = n.port, d = p.device;
        const it = new vscode.TreeItem(`Port ${p.number}${p.name ? `: ${p.name}` : ''}`, p.entries.length ? C.Collapsed : C.None);
        it.description = d ? [d.name, d.vendor].filter(Boolean).join(' · ') : p.mode ?? 'not configured';
        it.iconPath = new vscode.ThemeIcon(d ? 'plug' : 'debug-disconnect');
        const rows = [
          ['Mode', p.mode], ['Device', d?.name], ['Vendor', d?.vendor], ['Family', d?.family], ['Description', d?.text],
          ['Vendor ID', d?.vendorId !== undefined ? `${d.vendorId} (${hex(d.vendorId, 4)})` : undefined],
          ['Device ID', d?.deviceId !== undefined ? `${d.deviceId} (${hex(d.deviceId, 6)})` : undefined],
          ['IODD', d?.iodd], ['Process data', p.pdo && `${p.pdo}, ${p.entries.length} entries, ${p.entries.filter(e => e.linked.length).length} linked`],
        ].filter(r => r[1]);
        it.tooltip = new vscode.MarkdownString(`**Port ${p.number}${p.name ? `: ${p.name}` : ''}**\n\n` + rows.map(r => `${r[0]}: ${r[1]}`).join('  \n'));
        it.contextValue = 'iolink.port';
        it.id = `iolink:${n.master.path}^port${p.number}`;
        return it;
      }
      case 'entry': {
        const e = n.entry;
        const it = new vscode.TreeItem(e.name, C.None);
        it.description = [e.type, e.linked.length && `⇄ ${e.linked.join(', ')}`].filter(Boolean).join(' ');
        it.iconPath = new vscode.ThemeIcon(e.linked.length ? 'link' : 'symbol-field');
        it.tooltip = e.linked.length ? `${e.name} (${e.type}) linked to ${e.linked.join(', ')}` : `${e.name} (${e.type}), not linked`;
        it.contextValue = 'iolink.entry';
        return it;
      }
      case 'message': {
        const it = new vscode.TreeItem(n.text, C.None);
        it.iconPath = new vscode.ThemeIcon(n.icon);
        return it;
      }
    }
  }
}

/** Moves the masters into their own .xti files; per parent file from the last box to the first, so offsets stay valid. */
async function saveIndependent(masters: IoLinkMaster[]): Promise<string[]> {
  const byFile = new Map<string, IoLinkMaster[]>();
  for (const m of masters) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  const parents: { file: string; text: string }[] = [], created: { file: string; text: string }[] = [];
  for (const [file, ms] of byFile) {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(file));
    if (open?.isDirty) throw new Error(`${path.basename(file)} has unsaved changes. Save or revert it first.`);
    let text = await fs.readFile(file, 'utf8');
    for (const m of [...ms].sort((a, b) => b.offset - a.offset)) {
      const x = extractBox(text, file, m.offset);
      if (created.some(c => c.file.toLowerCase() === x.file.toLowerCase()) || await fs.stat(x.file).then(() => true, () => false))
        throw new Error(`${path.basename(x.file)} already exists in ${path.dirname(x.file)}. Rename or remove it first.`);
      created.push({ file: x.file, text: x.content });
      text = x.parent;
    }
    parents.push({ file, text });
  }
  // The new files first: should a write fail, the parents still hold every box.
  for (const c of created) {
    await fs.mkdir(path.dirname(c.file), { recursive: true });
    await fs.writeFile(c.file, c.text, 'utf8');
  }
  for (const p of parents) await fs.writeFile(p.file, p.text, 'utf8');
  return created.map(c => c.file);
}

export function registerIoLinkView(ctx: vscode.ExtensionContext, state: WorkspaceState) {
  const tree = new IoLinkTree(state);
  let timer: NodeJS.Timeout | undefined;
  const w = vscode.workspace.createFileSystemWatcher('**/*.xti');
  const later = () => { clearTimeout(timer); timer = setTimeout(() => tree.refresh(), 400); };
  ctx.subscriptions.push(w, w.onDidChange(later), w.onDidCreate(later), w.onDidDelete(later), { dispose: () => clearTimeout(timer) });

  const run = async (masters: IoLinkMaster[], what: string): Promise<void> => {
    if (!masters.length) { vscode.window.showInformationMessage('IECode: every IO-Link master is already stored in its own file.'); return; }
    const pick = await vscode.window.showWarningMessage(`Save ${what} as independent project file${masters.length > 1 ? 's' : ''}?`, {
      modal: true,
      detail: masters.map(m => `${m.name} (${path.basename(m.file)})`).join('\n')
        + '\n\nEach box moves into its own .xti next to its parent file, as TwinCAT does. Close the project in TwinCAT XAE first, it would overwrite the change.',
    }, 'Save');
    if (pick !== 'Save') return;
    try {
      const files = await saveIndependent(masters);
      tree.refresh();
      const open = await vscode.window.showInformationMessage(`IECode: saved ${files.length} independent project file(s).`, files.length === 1 ? 'Open' : 'Open First');
      if (open) await vscode.window.showTextDocument(vscode.Uri.file(files[0]), { preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`);
    }
  };

  const reveal = async (m: IoLinkMaster) => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
    const pos = doc.positionAt(m.offset);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  };
  const source: IoLinkSource = {
    projects: () => tree.projects(), structure: t => tree.structure(t), onDidChange: tree.onDidChangeTreeData,
    saveIndependent: run, reveal,
  };

  const inlineMasters = async (projects: Project[]) =>
    (await Promise.all(projects.map(p => tree.structure(p.tsproj).then(s => s.masters, () => [])))).flat().filter(m => !m.independent);

  ctx.subscriptions.push(
    vscode.window.createTreeView('iecode.ioLink', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.commands.registerCommand('iecode.ioLinkRefresh', () => tree.refresh()),
    vscode.commands.registerCommand('iecode.ioLinkSaveIndependent', (n?: IoLinkNode) => {
      if (n?.kind === 'master') return run([n.master], n.master.name);
    }),
    vscode.commands.registerCommand('iecode.ioLinkSaveAllIndependent', async (n?: IoLinkNode) => {
      const masters = await inlineMasters(n?.kind === 'project' ? [n.project] : tree.projects());
      return run(masters, masters.length === 1 ? masters[0].name : `all ${masters.length} IO-Link masters`);
    }),
    vscode.commands.registerCommand('iecode.ioLinkReveal', (n?: IoLinkNode) => n?.kind === 'master' ? reveal(n.master) : undefined),
    vscode.commands.registerCommand('iecode.ioLinkExplorer', (n?: IoLinkNode) =>
      showIoLinkExplorer(ctx, source, n?.kind === 'master' ? { tsproj: n.project.tsproj, path: n.master.path } : undefined)),
  );
}
