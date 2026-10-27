import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { listMembers, Member, ObjectType, PlcObject, LibraryRef, Solution, TwinCatProject } from '../core/projects';
import { Group, Unit, librariesByTitle, systemProjects } from '../core/workspace';
import { WorkspaceState } from '../state';

/** Tree nodes. `contextValue` drives the context menus in package.json. */
export type Node =
  | { kind: 'group'; group: Group; units: Unit[] }
  | { kind: 'systems'; systems: { solution: Solution; project: TwinCatProject }[] }
  | { kind: 'system'; solution: Solution; project: TwinCatProject }
  | { kind: 'unit'; unit: Unit }
  | { kind: 'references'; unit: Unit }
  | { kind: 'reference'; unit: Unit; ref: LibraryRef }
  | { kind: 'folder'; unit: Unit; rel: string }
  | { kind: 'object'; unit: Unit; obj: PlcObject }
  | { kind: 'member'; unit: Unit; obj: PlcObject; member: Member };

const GROUP_LABEL: Record<Group, string> = { library: 'Libraries', application: 'Applications', standalone: 'Standalone PLC' };

const TYPE_ICON: Record<ObjectType, string> = {
  FUNCTION_BLOCK: 'symbol-class', PROGRAM: 'symbol-module', FUNCTION: 'symbol-function', INTERFACE: 'symbol-interface',
  STRUCT: 'symbol-structure', ENUM: 'symbol-enum', UNION: 'symbol-structure', ALIAS: 'symbol-type-parameter',
  GVL: 'symbol-variable', TASK: 'watch', OTHER: 'file',
};
const TYPE_SHORT: Partial<Record<ObjectType, string>> = { FUNCTION_BLOCK: 'FB', PROGRAM: 'PRG', FUNCTION: 'FUN', INTERFACE: 'ITF', ENUM: 'ENUM', STRUCT: 'STRUCT', UNION: 'UNION', ALIAS: 'ALIAS', GVL: 'GVL' };
const MEMBER_ICON: Record<Member['kind'], string> = { METHOD: 'symbol-method', PROPERTY: 'symbol-property', ACTION: 'symbol-event', TRANSITION: 'arrow-right' };

const hasMembers = (t: ObjectType) => t === 'FUNCTION_BLOCK' || t === 'PROGRAM' || t === 'INTERFACE' || t === 'FUNCTION';

export class ProjectTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly state: WorkspaceState) {
    state.onDidChange(() => this.changed.fire(undefined));
  }

  refresh() { this.changed.fire(undefined); }

  getChildren(n?: Node): vscode.ProviderResult<Node[]> {
    const m = this.state.current;
    if (!n) {
      const groups = (['library', 'application', 'standalone'] as Group[])
        .map(g => ({ kind: 'group' as const, group: g, units: m.units.filter(u => u.group === g) }))
        .filter(g => g.units.length);
      const systems = systemProjects(m);
      return systems.length ? [...groups, { kind: 'systems', systems }] : groups;
    }
    switch (n.kind) {
      case 'group': return n.units.map(unit => ({ kind: 'unit' as const, unit }));
      case 'systems': return n.systems.map(s => ({ kind: 'system' as const, ...s }));
      case 'unit': return [{ kind: 'references', unit: n.unit }, ...this.folderChildren(n.unit, '')];
      case 'references': return n.unit.plc.references.map(ref => ({ kind: 'reference' as const, unit: n.unit, ref }));
      case 'folder': return this.folderChildren(n.unit, n.rel);
      case 'object': return this.members(n.unit, n.obj);
      default: return [];
    }
  }

  private folderChildren(unit: Unit, rel: string): Node[] {
    const prefix = rel ? rel + '/' : '';
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    const sub = new Set<string>();
    for (const f of unit.plc.folders) if (f.startsWith(prefix) && f !== rel) sub.add(prefix + f.slice(prefix.length).split('/')[0]);
    for (const o of unit.plc.objects) if (o.rel.startsWith(prefix) && o.rel.slice(prefix.length).includes('/')) sub.add(prefix + o.rel.slice(prefix.length).split('/')[0]);
    const folders = [...sub].sort((a, b) => a.localeCompare(b)).map(f => ({ kind: 'folder' as const, unit, rel: f }));
    const objects = unit.plc.objects.filter(o => direct(o.rel)).sort((a, b) => a.name.localeCompare(b.name)).map(obj => ({ kind: 'object' as const, unit, obj }));
    return [...folders, ...objects];
  }

  private async members(unit: Unit, obj: PlcObject): Promise<Node[]> {
    try {
      const xml = await fs.readFile(obj.file, 'utf8');
      return listMembers(xml).map(member => ({ kind: 'member' as const, unit, obj, member }));
    } catch {
      return [];
    }
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'group': {
        const it = new vscode.TreeItem(GROUP_LABEL[n.group], C.Expanded);
        it.contextValue = 'group';
        return it;
      }
      case 'systems': {
        const it = new vscode.TreeItem('System Projects', C.Expanded);
        it.contextValue = 'systems';
        return it;
      }
      case 'system': {
        const p = n.project;
        const it = new vscode.TreeItem(p.name, C.None);
        it.description = path.basename(n.solution.file);
        it.iconPath = new vscode.ThemeIcon('server-environment');
        it.tooltip = new vscode.MarkdownString(`**${p.name}** (no PLC project)  \n${p.file}${p.tcVersion ? `  \nTwinCAT ${p.tcVersion}` : ''}`);
        it.contextValue = 'system';
        it.resourceUri = vscode.Uri.file(p.file);
        it.id = `system:${p.file}`;
        it.command = { command: 'iecode.ioLinks', title: 'IO Links', arguments: [n] };
        return it;
      }
      case 'unit': {
        const p = n.unit.plc;
        const it = new vscode.TreeItem(p.isLibrary ? (p.title ?? p.name) : n.unit.id, C.Collapsed);
        it.description = p.isLibrary ? p.version : n.unit.solution ? path.basename(n.unit.solution.file) : path.basename(p.file);
        it.iconPath = new vscode.ThemeIcon(p.isLibrary ? 'library' : n.unit.group === 'standalone' ? 'beaker' : 'circuit-board');
        it.tooltip = new vscode.MarkdownString(`**${p.name}**  \n${p.file}${p.tcVersion ? `  \nTwinCAT ${p.tcVersion}` : ''}`);
        it.contextValue = `unit.${n.unit.group}${n.unit.solution ? '.sln' : ''}`;
        it.resourceUri = vscode.Uri.file(p.file);
        it.id = `unit:${p.file}`;
        return it;
      }
      case 'references': {
        const it = new vscode.TreeItem('References', C.Collapsed);
        it.description = `${n.unit.plc.references.length}`;
        it.iconPath = new vscode.ThemeIcon('references');
        it.contextValue = 'references';
        it.id = `refs:${n.unit.plc.file}`;
        return it;
      }
      case 'reference': {
        const e = n.ref.effective;
        const lib = librariesByTitle(this.state.current.units).get(e.name.toLowerCase());
        const it = new vscode.TreeItem(e.name, C.None);
        it.description = lib ? `${e.version} · ⇄ workspace ${lib.plc.version}` : e.version === '*' ? '* (newest)' : e.version;
        it.tooltip = `${e.name}, ${e.version} (${e.vendor})${n.ref.pinned ? ' · pinned resolution' : ''}`;
        it.iconPath = new vscode.ThemeIcon(lib ? 'link' : 'package');
        it.contextValue = lib ? 'reference.workspace' : 'reference';
        return it;
      }
      case 'folder': {
        const it = new vscode.TreeItem(path.posix.basename(n.rel), C.Collapsed);
        it.iconPath = vscode.ThemeIcon.Folder;
        it.contextValue = 'folder';
        it.id = `folder:${n.unit.plc.file}:${n.rel}`;
        return it;
      }
      case 'object': {
        const o = n.obj;
        const it = new vscode.TreeItem(o.name, hasMembers(o.type) && !o.encrypted ? C.Collapsed : C.None);
        it.description = [TYPE_SHORT[o.type], o.extends && `: ${o.extends}`, o.implements?.length && `⊢ ${o.implements.join(', ')}`].filter(Boolean).join(' ');
        it.iconPath = new vscode.ThemeIcon(o.encrypted ? 'lock' : TYPE_ICON[o.type]);
        if (o.encrypted) it.description = 'encrypted';
        it.resourceUri = vscode.Uri.file(o.file);
        it.tooltip = o.file;
        it.contextValue = o.encrypted ? 'object.encrypted' : `object.${o.type}`;
        it.id = `obj:${o.file}`;
        if (!o.encrypted) it.command = { command: 'iecode.openAsST', title: 'Open', arguments: [vscode.Uri.file(o.file)] };
        return it;
      }
      case 'member': {
        const m = n.member;
        const it = new vscode.TreeItem(m.name, C.None);
        it.description = m.kind === 'PROPERTY' ? `${m.signature.replace(/^PROPERTY\s+(\w+\s+)?\w+\s*/i, '')} ${[m.get && 'get', m.set && 'set'].filter(Boolean).join('/')}` : m.signature.replace(/^(METHOD|ACTION|TRANSITION)\s+(?:(PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)*\w+\s*/i, '');
        it.iconPath = new vscode.ThemeIcon(MEMBER_ICON[m.kind]);
        it.contextValue = `member.${m.kind}`;
        it.command = { command: 'iecode.revealMember', title: 'Open', arguments: [n] };
        return it;
      }
    }
  }

  getParent(): undefined { return undefined; }
}
