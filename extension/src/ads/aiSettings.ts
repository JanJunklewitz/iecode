// Settings readers shared by the ADS watch view and the LM tools, so the view does not depend on the tools module.

import * as vscode from 'vscode';
import { workspaceOverrides } from '../core/adswatch';

/**
 * `iecode.ads.aiWrites` from the user settings only. The setting is application-scoped; reading the global value
 * also keeps a workspace `.vscode/settings.json` from turning on auto-approve should VS Code ever apply one.
 */
export function aiWritesSetting(): string {
  return vscode.workspace.getConfiguration('iecode.ads').inspect<string>('aiWrites')?.globalValue ?? 'off';
}

/**
 * True if the workspace settings, or the settings of any workspace folder (multi-root), point iecode.ads.target or
 * .port somewhere else than the user settings.
 */
export function workspaceTarget(): boolean {
  const scopes = [undefined, ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)];
  return scopes.some(uri => {
    const c = vscode.workspace.getConfiguration('iecode.ads', uri);
    return workspaceOverrides(c.inspect<string>('target')) || workspaceOverrides(c.inspect<number>('port'));
  });
}
