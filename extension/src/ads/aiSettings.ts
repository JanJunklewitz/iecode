// Settings readers shared by the ADS watch view and the LM tools, so the view does not depend on the tools module.

import * as vscode from 'vscode';
import { checkLogDirectory } from '../core/logRead';
import { workspaceOverrides } from '../core/adswatch';

/**
 * `iecode.ads.aiWrites` from the user settings only. The setting is application-scoped; reading the global value
 * also keeps a workspace `.vscode/settings.json` from turning on auto-approve should VS Code ever apply one.
 */
export function aiWritesSetting(): string {
  return vscode.workspace.getConfiguration('iecode.ads').inspect<string>('aiWrites')?.globalValue ?? 'off';
}

/** `iecode.ads.aiWritePaths` from the user settings only (empty: no restriction). */
export function aiWritePathsSetting(): string[] {
  const v = vscode.workspace.getConfiguration('iecode.ads').inspect<unknown>('aiWritePaths')?.globalValue;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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

/**
 * `iecode.ads.logDirectory` from the user settings only (a workspace value could point the log tool at any folder, and the
 * tool returns file content to the AI). Unset, not a string or not a full path gives the reason as text.
 */
export function logDirectorySetting(): { dir: string } | { problem: string } {
  return checkLogDirectory(vscode.workspace.getConfiguration('iecode.ads').inspect<unknown>('logDirectory')?.globalValue);
}
