// Writes an iecode.ads.* setting where its current value comes from: a workspace value would otherwise silently win over a change made in the UI.

import * as vscode from 'vscode';

export async function writeAdsSetting(key: string, value: string | number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('iecode.ads');
  const i = cfg.inspect(key);
  const scope = i?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update(key, value, scope);
}
