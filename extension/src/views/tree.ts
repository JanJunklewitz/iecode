import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { MemberGrouping, listMemberFolders, listMembers, memberLevel, Member, ObjectType, PlcObject, LibraryRef, Solution, TwinCatProject } from '../core/projects';
import { Group, Unit, librariesByTitle, systemProjects } from '../core/workspace';
import { WorkspaceState } from '../state';
import { LIB_SCHEME, LibrarySource, LibrarySources } from '../lang/librarySources';
import { LibraryObject } from '../core/libraryArchive';
import { TYPE_SHORT, TreeFilter, filterIdSuffix, visibleIn } from '../core/treeFilter';

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
  | { kind: 'member'; unit: Unit; obj: PlcObject; member: Member }
  // folder inside a POU (TwinCAT folders, or a Methods / Properties … group): `rel` is the folder path, '#KIND' for a group
  | { kind: 'memberFolder'; unit: Unit; obj: PlcObject; rel: string }
  | { kind: 'libraryMemberFolder'; lib: LibrarySource; key: string; obj: LibraryObject; rel: string }
  // sources of a referenced .library (read-only)
  | { kind: 'libraryFolder'; lib: LibrarySource; rel: string }
  | { kind: 'libraryObject'; lib: LibrarySource; key: string; obj: LibraryObject }
  | { kind: 'libraryMember'; key: string; member: Member };

const GROUP_LABEL: Record<Group, string> = { library: 'Libraries', application: 'Applications', standalone: 'Standalone PLC' };

const TYPE_ICON: Record<ObjectType, string> = {
  FUNCTION_BLOCK: 'symbol-class', PROGRAM: 'symbol-module', FUNCTION: 'symbol-function', INTERFACE: 'symbol-interface',
  STRUCT: 'symbol-structure', ENUM: 'symbol-enum', UNION: 'symbol-structure', ALIAS: 'symbol-type-parameter',
  GVL: 'symbol-variable', TASK: 'watch', TEXTLIST: 'symbol-text', IMAGEPOOL: 'file-media', VISUMANAGER: 'settings', OTHER: 'file',
};
const MEMBER_ICON: Record<Member['kind'], string> = { METHOD: 'symbol-method', PROPERTY: 'symbol-property', ACTION: 'symbol-event', TRANSITION: 'arrow-right' };

const KIND_GROUP: Record<Member['kind'], string> = { METHOD: 'Methods', PROPERTY: 'Properties', ACTION: 'Actions', TRANSITION: 'Transitions' };

const grouping = () => vscode.workspace.getConfiguration('iecode').get<MemberGrouping>('memberGrouping', 'folders');

const hasMembers = (t: ObjectType) => t === 'FUNCTION_BLOCK' || t === 'PROGRAM' || t === 'INTERFACE' || t === 'FUNCTION';

export class ProjectTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private active: TreeFilter | undefined;
  private generation = 0;
  /** Hits per unit for the active filter; keyed by the Unit object so a reloaded model starts empty. */
  private visible = new WeakMap<Unit, ReturnType<typeof visibleIn>>();

  constructor(private readonly state: WorkspaceState, private readonly libraries: LibrarySources) {
    state.onDidChange(() => { this.visible = new WeakMap(); this.changed.fire(undefined); });
    libraries.onDidChange(() => this.changed.fire(undefined));
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('iecode.memberGrouping')) this.changed.fire(undefined); });
  }

  refresh() { this.changed.fire(undefined); }

  /** Sets (or clears) the name/kind filter; a new generation gives the nodes new ids so VS Code expands them. */
  setFilter(f: TreeFilter | undefined) {
    this.active = f;
    this.generation++;
    this.visible = new WeakMap();
    this.changed.fire(undefined);
  }

  filter(): TreeFilter | undefined { return this.active; }

  /** Hits of the current filter in the current model. */
  hits(): { objects: number; projects: number } {
    let objects = 0, projects = 0;
    if (this.active) for (const u of this.state.current.units) {
      const n = this.hitsIn(u)!.objects.size;
      objects += n;
      if (n) projects++;
    }
    return { objects, projects };
  }

  private hitsIn(unit: Unit) {
    if (!this.active) return undefined;
    let v = this.visible.get(unit);
    if (!v) this.visible.set(unit, v = visibleIn(this.active, unit.plc.objects));
    return v;
  }

  getChildren(n?: Node): vscode.ProviderResult<Node[]> {
    const m = this.state.current;
    if (!n) {
      const groups = (['library', 'application', 'standalone'] as Group[])
        .map(g => ({ kind: 'group' as const, group: g, units: m.units.filter(u => u.group === g && (!this.active || this.hitsIn(u)!.objects.size)) }))
        .filter(g => g.units.length);
      if (this.active) return groups;
      const systems = systemProjects(m);
      return systems.length ? [...groups, { kind: 'systems', systems }] : groups;
    }
    switch (n.kind) {
      case 'group': return n.units.map(unit => ({ kind: 'unit' as const, unit }));
      case 'systems': return n.systems.map(s => ({ kind: 'system' as const, ...s }));
      case 'unit': return this.active ? this.folderChildren(n.unit, '') : [{ kind: 'references', unit: n.unit }, ...this.folderChildren(n.unit, '')];
      case 'references': return n.unit.plc.references.map(ref => ({ kind: 'reference' as const, unit: n.unit, ref }));
      case 'folder': return this.folderChildren(n.unit, n.rel);
      case 'object': return this.members(n.unit, n.obj, '');
      case 'memberFolder': return this.members(n.unit, n.obj, n.rel);
      case 'libraryMemberFolder': return this.libraryMembers(n.lib, n.key, n.obj, n.rel);
      case 'reference': {
        const lib = this.libraries.get(n.ref.effective.name);
        return lib ? this.libraryChildren(lib, '') : [];
      }
      case 'libraryFolder': return this.libraryChildren(n.lib, n.rel);
      case 'libraryObject': return this.libraryMembers(n.lib, n.key, n.obj, '');
      default: return [];
    }
  }

  private folderChildren(unit: Unit, rel: string): Node[] {
    const prefix = rel ? rel + '/' : '';
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    const vis = this.hitsIn(unit);
    const objs = vis ? unit.plc.objects.filter(o => vis.objects.has(o)) : unit.plc.objects;
    const sub = new Set<string>();
    if (!vis) for (const f of unit.plc.folders) if (f.startsWith(prefix) && f !== rel) sub.add(prefix + f.slice(prefix.length).split('/')[0]);
    for (const o of objs) if (o.rel.startsWith(prefix) && o.rel.slice(prefix.length).includes('/')) sub.add(prefix + o.rel.slice(prefix.length).split('/')[0]);
    const folders = [...sub].sort((a, b) => a.localeCompare(b)).map(f => ({ kind: 'folder' as const, unit, rel: f }));
    const objects = objs.filter(o => direct(o.rel)).sort((a, b) => a.name.localeCompare(b.name)).map(obj => ({ kind: 'object' as const, unit, obj }));
    return [...folders, ...objects];
  }

  private libraryChildren(lib: LibrarySource, rel: string): Node[] {
    const prefix = rel ? rel + '/' : '';
    const sub = new Set<string>();
    for (const o of lib.objects)
      if (o.obj.folder === rel || o.obj.folder.startsWith(prefix)) {
        const rest = o.obj.folder.slice(prefix.length);
        if (o.obj.folder !== rel && rest) sub.add(prefix + rest.split('/')[0]);
      }
    const folders = [...sub].sort((a, b) => a.localeCompare(b)).map(f => ({ kind: 'libraryFolder' as const, lib, rel: f }));
    const objects = lib.objects.filter(o => o.obj.folder === rel).sort((a, b) => a.obj.name.localeCompare(b.obj.name))
      .map(o => ({ kind: 'libraryObject' as const, lib, key: o.key, obj: o.obj }));
    return [...folders, ...objects];
  }

  private async members(unit: Unit, obj: PlcObject, rel: string): Promise<Node[]> {
    try {
      const xml = await fs.readFile(obj.file, 'utf8');
      const level = memberLevel(listMembers(xml), listMemberFolders(xml), rel, grouping());
      return [
        ...level.folders.map(f => ({ kind: 'memberFolder' as const, unit, obj, rel: f })),
        ...level.members.map(member => ({ kind: 'member' as const, unit, obj, member })),
      ];
    } catch {
      return [];
    }
  }

  private libraryMembers(lib: LibrarySource, key: string, obj: LibraryObject, rel: string): Node[] {
    try {
      const level = memberLevel(listMembers(obj.xml), listMemberFolders(obj.xml), rel, grouping());
      return [
        ...level.folders.map(f => ({ kind: 'libraryMemberFolder' as const, lib, key, obj, rel: f })),
        ...level.members.map(member => ({ kind: 'libraryMember' as const, key, member })),
      ];
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
        if (this.active) it.id = `group:${n.group}${filterIdSuffix(this.generation)}`;
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
        const it = new vscode.TreeItem(p.isLibrary ? (p.title ?? p.name) : n.unit.id, this.active ? C.Expanded : C.Collapsed);
        it.description = p.isLibrary ? p.version : n.unit.solution ? path.basename(n.unit.solution.file) : path.basename(p.file);
        it.iconPath = new vscode.ThemeIcon(p.isLibrary ? 'library' : n.unit.group === 'standalone' ? 'beaker' : 'circuit-board');
        it.tooltip = new vscode.MarkdownString(`**${p.name}**  \n${p.file}${p.tcVersion ? `  \nTwinCAT ${p.tcVersion}` : ''}`);
        it.contextValue = `unit.${n.unit.group}${n.unit.solution ? '.sln' : ''}`;
        it.resourceUri = vscode.Uri.file(p.file);
        it.id = `unit:${p.file}${this.active ? filterIdSuffix(this.generation) : ''}`;
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
        const src = lib ? undefined : this.libraries.get(e.name);
        const it = new vscode.TreeItem(e.name, src?.objects.length ? C.Collapsed : C.None);
        it.description = lib ? `${e.version} · ⇄ workspace ${lib.plc.version}` : e.version === '*' ? `* (newest${src?.version ? ': ' + src.version : ''})` : e.version;
        if (src?.compiled && !src.file) it.description += ' · compiled';
        it.tooltip = `${e.name}, ${e.version} (${e.vendor})${n.ref.pinned ? ' · pinned resolution' : ''}`
          + (src?.file ? `\nSources: ${src.file}` : src?.compiled ? '\nCompiled library: no sources' : src?.error ? `\n${src.error}` : '');
        it.iconPath = new vscode.ThemeIcon(lib ? 'link' : 'package');
        it.contextValue = lib ? 'reference.workspace' : 'reference';
        return it;
      }
      case 'folder': {
        const it = new vscode.TreeItem(path.posix.basename(n.rel), this.active ? C.Expanded : C.Collapsed);
        it.iconPath = vscode.ThemeIcon.Folder;
        it.contextValue = 'folder';
        it.id = `folder:${n.unit.plc.file}:${n.rel}${this.active ? filterIdSuffix(this.generation) : ''}`;
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
      case 'memberFolder':
      case 'libraryMemberFolder': {
        const group = n.rel.startsWith('#');
        const it = new vscode.TreeItem(group ? KIND_GROUP[n.rel.slice(1) as Member['kind']] : path.posix.basename(n.rel), C.Collapsed);
        it.iconPath = group ? new vscode.ThemeIcon(MEMBER_ICON[n.rel.slice(1) as Member['kind']]) : vscode.ThemeIcon.Folder;
        it.contextValue = n.kind === 'libraryMemberFolder' ? 'libraryMemberFolder' : group ? 'memberGroup' : `memberFolder.${n.obj.type}`;
        it.id = `${n.kind}:${n.kind === 'memberFolder' ? n.obj.file : n.key}:${n.rel}`;
        return it;
      }
      case 'libraryFolder': {
        const it = new vscode.TreeItem(path.posix.basename(n.rel), C.Collapsed);
        it.iconPath = vscode.ThemeIcon.Folder;
        it.contextValue = 'libraryFolder';
        it.id = `libfolder:${n.lib.file}:${n.rel}`;
        return it;
      }
      case 'libraryObject': {
        const o = n.obj;
        const it = new vscode.TreeItem(o.name, hasMembers(o.type) ? C.Collapsed : C.None);
        it.description = TYPE_SHORT[o.type];
        it.iconPath = new vscode.ThemeIcon(TYPE_ICON[o.type]);
        it.tooltip = `${o.name} (library ${n.lib.id.name}, read-only)`;
        it.contextValue = `libraryObject.${o.type}`;
        it.id = `libobj:${n.key}`;
        it.command = { command: 'vscode.open', title: 'Open', arguments: [LibrarySources.uri(n.key)] };
        return it;
      }
      case 'libraryMember':
      case 'member': {
        const m = n.member;
        const it = new vscode.TreeItem(m.name, C.None);
        it.description = m.kind === 'PROPERTY' ? `${m.signature.replace(/^PROPERTY\s+(\w+\s+)?\w+\s*/i, '')} ${[m.get && 'get', m.set && 'set'].filter(Boolean).join('/')}` : m.signature.replace(/^(METHOD|ACTION|TRANSITION)\s+(?:(PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)*\w+\s*/i, '');
        it.iconPath = new vscode.ThemeIcon(MEMBER_ICON[m.kind]);
        it.contextValue = n.kind === 'member' ? `member.${m.kind}` : `libraryMember.${m.kind}`;
        it.command = { command: 'iecode.revealMember', title: 'Open', arguments: [n] };
        return it;
      }
    }
  }

  /** Parent of a node, for TreeView.reveal (members and member folders are not revealed). */
  getParent(n: Node): Node | undefined {
    const m = this.state.current;
    const unitNode = (unit: Unit): Node => ({ kind: 'unit', unit });
    const folderOrUnit = (unit: Unit, rel: string): Node => {
      const dir = path.posix.dirname(rel);
      return dir === '.' || dir === '' ? unitNode(unit) : { kind: 'folder', unit, rel: dir };
    };
    switch (n.kind) {
      case 'group':
      case 'systems': return undefined;
      case 'system': return { kind: 'systems', systems: systemProjects(m) };
      case 'unit': return { kind: 'group', group: n.unit.group, units: m.units.filter(u => u.group === n.unit.group) };
      case 'references': return unitNode(n.unit);
      case 'reference': return { kind: 'references', unit: n.unit };
      case 'folder':
      case 'object': return folderOrUnit(n.unit, n.kind === 'folder' ? n.rel : n.obj.rel);
      case 'libraryFolder':
      case 'libraryObject': {
        const rel = n.kind === 'libraryFolder' ? n.rel : n.obj.folder;
        const dir = n.kind === 'libraryFolder' ? path.posix.dirname(rel) : rel;
        if (dir && dir !== '.') return { kind: 'libraryFolder', lib: n.lib, rel: dir };
        return this.referenceTo(n.lib);
      }
      default: return undefined;
    }
  }

  /** The first reference in the tree that shows the sources of this library. */
  private referenceTo(lib: LibrarySource): Node | undefined {
    const name = lib.id.name.toLowerCase();
    const inWorkspace = librariesByTitle(this.state.current.units);   // those references show no sources
    for (const unit of this.state.current.units) {
      const ref = unit.plc.references.find(r => r.effective.name.toLowerCase() === name);
      if (ref && !inWorkspace.has(name) && this.libraries.get(ref.effective.name) === lib) return { kind: 'reference', unit, ref };
    }
    return undefined;
  }

  /** The tree node of an object, PLC project or library object shown in an editor. */
  nodeFor(uri: vscode.Uri): Node | undefined {
    if (uri.scheme === LIB_SCHEME) {
      const key = uri.fsPath.toLowerCase();
      for (const lib of this.libraries.all()) {
        const o = lib.objects.find(x => x.key.toLowerCase() === key);
        if (o) return { kind: 'libraryObject', lib, key: o.key, obj: o.obj };
      }
      return undefined;
    }
    if (uri.scheme !== 'file' && uri.scheme !== 'iecode') return undefined;
    const file = samePath(uri.fsPath);
    for (const unit of this.state.current.units) {
      if (samePath(unit.plc.file) === file) return { kind: 'unit', unit };
      const obj = unit.plc.objects.find(o => samePath(o.file) === file);
      if (obj) return { kind: 'object', unit, obj };
    }
    return undefined;
  }
}

const samePath = (p: string) => {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

/** URI of the active editor tab: text, custom editor (visualizations …) or the modified side of a diff. */
function activeUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  return vscode.window.activeTextEditor?.document.uri;
}

/** Selects the object of the active editor in the project tree (setting `iecode.projects.autoReveal`). */
export function registerAutoReveal(view: vscode.TreeView<Node>, tree: ProjectTree, state: WorkspaceState): vscode.Disposable {
  const enabled = () => vscode.workspace.getConfiguration('iecode').get<boolean>('projects.autoReveal', true);
  const idOf = (n: Node) => tree.getTreeItem(n).id;
  const reveal = async () => {
    if (!view.visible || !enabled()) return;
    const uri = activeUri();
    const node = uri && tree.nodeFor(uri);
    if (!node) return;
    const id = idOf(node);
    if (id && view.selection.some(s => idOf(s) === id)) return;   // already selected: keep the user's expand/collapse state
    try {
      await view.reveal(node, { select: true, focus: false, expand: false });
    } catch {
      // the node is not in the tree (yet), e.g. while the workspace model reloads
    }
  };
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(() => void reveal()),
    vscode.window.tabGroups.onDidChangeTabs(e => { if (e.changed.some(t => t.isActive)) void reveal(); }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => void reveal()),
    view.onDidChangeVisibility(() => void reveal()),
    state.onDidChange(() => void reveal()),
  );
}
