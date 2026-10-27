// One-click setup for a new PC: installs the iecode CLI if it's missing and checks TwinCAT with `iecode doctor`.
// Viewing, editing and comparing objects as ST need no setup; this is for build, activate and libraries.

import * as vscode from 'vscode';
import { cliAvailable, cliInstalled, installCli, output, runCli } from '../cli/iecode';

const OFFERED = 'iecode.setupOffered';

async function setUp(): Promise<void> {
  if (!cliAvailable()) {
    vscode.window.showInformationMessage('IECode: nothing to set up on this OS. Viewing, editing and comparing work as they are; build and activate need Windows with TwinCAT XAE.');
    return;
  }
  if (!await cliInstalled()) {
    const pick = await vscode.window.showInformationMessage(
      'Set up IECode on this PC? This installs the iecode CLI for your user from the latest GitHub release (downloads, checks SHA256, adds it to PATH) and then checks the TwinCAT installation.',
      { modal: true }, 'Set up');
    if (pick !== 'Set up') return;
    if (!await installCli()) {
      vscode.window.showErrorMessage('IECode: installing the CLI failed. See the IECode output.');
      return;
    }
  }
  const res = await runCli(['doctor'], 'IECode: checking this PC');
  if (res.ok) {
    vscode.window.showInformationMessage('IECode is set up on this PC: CLI installed and TwinCAT found. Build and Activate are ready.');
  } else {
    output.show(true);
    vscode.window.showWarningMessage('IECode: the CLI is installed, but TwinCAT XAE is not ready on this PC (see the failed checks in the IECode output). Viewing and editing work anyway.');
  }
}

export function register(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.commands.registerCommand('iecode.setup', async () => {
    try { await setUp(); } catch (e) { vscode.window.showErrorMessage(`IECode: ${(e as Error).message}`); }
  }));

  // New users: offer the setup once, only if the CLI is missing.
  if (!cliAvailable() || ctx.globalState.get<boolean>(OFFERED)) return;
  void cliInstalled().then(async installed => {
    await ctx.globalState.update(OFFERED, true);
    if (installed) return;
    const pick = await vscode.window.showInformationMessage(
      'IECode: set up this PC for Build and Activate? Viewing and editing ST work without it.', 'Set up…', 'Not now');
    if (pick === 'Set up…') await vscode.commands.executeCommand('iecode.setup');
  });
}
