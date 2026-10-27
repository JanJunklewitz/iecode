// Runs the iecode CLI with --json and returns its result. Progress lines go to the "IECode" output channel.

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { CliDiagnostic } from '../core/diagnostics';

export interface CliResult<T = unknown> {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  twinCat?: string;
  data?: T;
  diagnostics: CliDiagnostic[];
  messages: string[];
  error?: string;
  hint?: string;
}

export const output = vscode.window.createOutputChannel('IECode');

export const cliAvailable = () => process.platform === 'win32';

function cliPath(): string {
  return customCliPath() ?? 'iecode';
}

/** Global options from settings, e.g. --tc 4024.66. */
function globalArgs(): string[] {
  const cfg = vscode.workspace.getConfiguration('iecode');
  const args: string[] = [];
  const tc = cfg.get<string>('tcVersion', 'auto');
  if (tc && tc !== 'auto') args.push('--tc', tc);
  if (cfg.get<boolean>('showXae', false)) args.push('--visible');
  return args;
}

export async function runCli<T = unknown>(args: string[], title: string, cwd?: string): Promise<CliResult<T>> {
  useInstallDir();
  const full = [...args, ...globalArgs(), '--json'];
  output.appendLine(`> iecode ${full.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) =>
    new Promise<CliResult<T>>((resolve, reject) => {
      const child = spawn(cliPath(), full, { cwd, env: { ...process.env, IECODE_PROGRESS: '1', NO_COLOR: '1' }, windowsHide: true });
      let stdout = '';
      let errBuf = '';
      child.stdout.on('data', d => (stdout += d.toString()));
      child.stderr.on('data', d => {
        errBuf += d.toString();
        let nl: number;
        while ((nl = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, nl).replace(/\r$/, '');
          errBuf = errBuf.slice(nl + 1);
          if (!line) continue;
          output.appendLine(line);
          progress.report({ message: line.replace(/^[●✔✖⚠]\s*/, '') });
        }
      });
      token.onCancellationRequested(() => child.kill());
      child.on('error', e => reject(new Error(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? `iecode CLI not found ("${cliPath()}"). Install it (see IECode: Install CLI) or set iecode.cliPath.`
          : e.message)));
      child.on('close', code => {
        try {
          const json = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
          const res = JSON.parse(json) as CliResult<T>;
          output.appendLine(`  ${res.ok ? '✔' : '✖'} ${res.command} · exit ${res.exitCode} · ${(res.durationMs / 1000).toFixed(1)} s${res.error ? ' · ' + res.error : ''}`);
          resolve(res);
        } catch {
          reject(new Error(token.isCancellationRequested ? 'Cancelled' : `iecode exited with ${code} without a result. See the IECode output.`));
        }
      });
    }));
}

/** Shows the CLI's error with its hint; offers the output channel. */
export async function reportFailure(res: CliResult, what: string) {
  const msg = res.error ?? `${what} failed (exit ${res.exitCode})`;
  const pick = await vscode.window.showErrorMessage(`IECode: ${msg}${res.hint ? ' — ' + res.hint : ''}`, 'Show Output');
  if (pick) output.show();
}

/** Folder install.ps1 installs to (%LOCALAPPDATA%\iecode). */
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'iecode');

/**
 * VS Code keeps the PATH it was started with, so a CLI installed while it runs isn't found by name.
 * Adds the install folder to the end of this process's PATH when the CLI is there, so an iecode found
 * earlier on PATH (e.g. the NuGet tool or a dev build) still wins.
 */
export function useInstallDir() {
  if (!existsSync(path.join(INSTALL_DIR, 'iecode.exe'))) return;
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  if (!dirs.some(d => d.toLowerCase() === INSTALL_DIR.toLowerCase())) process.env.PATH = [...dirs, INSTALL_DIR].join(path.delimiter);
}

/** The iecode.cliPath setting, when set (installing doesn't fix a wrong one). */
export const customCliPath = () => vscode.workspace.getConfiguration('iecode').get<string>('cliPath', '').trim() || undefined;

/** True if the configured CLI starts (`iecode --version`). */
export function cliInstalled(): Promise<boolean> {
  useInstallDir();
  return new Promise(resolve => {
    const child = spawn(cliPath(), ['--version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

/** Installs the CLI for the current user from the latest GitHub release (install.ps1); the log goes to the output channel. */
export function installCli(): Promise<boolean> {
  const script = 'irm https://github.com/JanJunklewitz/iecode/releases/latest/download/install.ps1 | iex';
  output.show(true);
  output.appendLine(`> ${script}`);
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'IECode: installing the CLI' }, () =>
    new Promise<boolean>(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      child.stdout.on('data', d => output.append(d.toString()));
      child.stderr.on('data', d => output.append(d.toString()));
      child.on('error', e => { output.appendLine(e.message); resolve(false); });
      child.on('close', code => resolve(code === 0));
    }))).then(async ok => ok && await cliInstalled());
}
