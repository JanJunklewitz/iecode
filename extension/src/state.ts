import * as vscode from 'vscode';
import { discover, WorkspaceModel } from './core/workspace';

/** Holds the workspace model and reloads it (debounced) when project or object files change. */
export class WorkspaceState implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<WorkspaceModel>();
  readonly onDidChange = this.changed.event;
  private model: WorkspaceModel = { solutions: [], units: [], edges: [], errors: [] };
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<WorkspaceModel> | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{sln,tsproj,tspproj,plcproj,TcPOU,TcDUT,TcGVL,TcIO,TcTTO}');
    const later = () => this.schedule();
    this.subs.push(w, w.onDidCreate(later), w.onDidDelete(later), w.onDidChange(later),
      vscode.workspace.onDidChangeWorkspaceFolders(later));
  }

  get current() { return this.model; }

  /** Loads the model now (or returns the load in progress). */
  reload(): Promise<WorkspaceModel> {
    this.loading ??= (async () => {
      try {
        const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        this.model = await discover(roots);
        for (const e of this.model.errors) console.warn(`IECode: ${e.file}: ${e.message}`);
        vscode.commands.executeCommand('setContext', 'iecode.hasProjects', this.model.units.length > 0);
        this.changed.fire(this.model);
        return this.model;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), 400);
  }

  dispose() {
    clearTimeout(this.timer);
    this.subs.forEach(s => s.dispose());
    this.changed.dispose();
  }
}
