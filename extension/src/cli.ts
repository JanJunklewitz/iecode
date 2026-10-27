#!/usr/bin/env node
// iecode-st decode <file.TcPOU>                       -> print ST view (also usable as git textconv; .TcVIS: YAML summary)
// iecode-st encode <file.TcPOU> <view.st>             -> splice view back into the object file
// iecode-st diff <a.TcPOU> <b.TcPOU>                  -> unified diff of the ST views
// iecode-st diff --rev <ref> [--to <ref>] <file>      -> ST diff against a git commit (default: working copy)
// iecode-st difftool <viewer> <a> <b>                 -> open the ST views in a graphical diff tool (git difftool cmd)
// iecode-st links <x.tsproj> [--csv|--yaml]           -> IO links of a TwinCAT project (--yaml: as hardware tree)
// iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> [--csv] -> IO link changes since a commit
// iecode-st ads <x.plcproj|x.tmc> [--rev <ref>] [--members] [--csv] -> ADS interface from source (.plcproj) or build output (.tmc)
// iecode-st ads-diff --rev <ref> [--to <ref>] <x.plcproj> [--members] [--csv] -> ADS interface changes in the source since a commit
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { decode, encode } from './model';
import { parseVisu, visuToText } from './core/tcvis';
import { isEncrypted } from './core/projects';
import { unifiedDiff } from './core/textdiff';
import { repoRoot, show } from './core/git';
import { changesToCsv, diffLinks, linksToCsv, shortPath } from './core/iolinks';
import { linksAt, projectAt } from './core/iohistory';
import { buildTree, treeToYaml } from './core/iotree';
import { loadPlcProject } from './core/projects';
import { AdsSymbol, adsChangesToCsv, diffSymbols, fromSourceAt, fromTmc, sizeText, symbolsToCsv } from './core/adsinterface';

const EXT_RE = /\.(TcPOU|TcDUT|TcGVL|TcIO|TcVIS)$/i;
/** ST view of an object, YAML summary of a visualization (git textconv runs on a temp file: detect by content). */
const toView = (xml: string) => (/<Visu\s/.test(xml.slice(0, 500)) ? visuToText(parseVisu(xml))
  : isEncrypted(xml) ? '(* encrypted object *)\n' : decode(xml.replace(/^﻿/, '')));

/** Writes the ST views of both files to a temp folder and runs the viewer on them; other files are passed as they are. */
function difftool(viewer: string, a: string, b: string): number {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iecode-difftool-'));
  try {
    const side = (file: string, sub: string) => {
      if (!EXT_RE.test(file)) return file;
      const out = path.join(dir, sub, path.basename(file) + (/\.TcVIS$/i.test(file) ? '.yaml' : '.st'));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, toView(readFileSync(file, 'utf8')), 'utf8');
      return out;
    };
    // a .cmd / .bat viewer needs a shell on Windows (spawn fails with EINVAL otherwise)
    const shell = /\.(cmd|bat)$/i.test(viewer);
    const q = (s: string) => (shell ? `"${s}"` : s);
    const r = spawnSync(q(viewer), [q(side(a, 'a')), q(side(b, 'b'))], { stdio: 'inherit', shell });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function atRef(file: string, ref: string | undefined): Promise<string> {
  if (!ref) return readFileSync(file, 'utf8');
  const root = await repoRoot(file);
  if (!root) throw new Error(`${file} is not in a git repository`);
  return (await show(root, ref, path.resolve(file))) ?? '';
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === 'decode' && args[0]) { process.stdout.write(toView(readFileSync(args[0], 'utf8'))); return 0; }
  if (cmd === 'encode' && args[0] && args[1]) {
    const xml = readFileSync(args[0], 'utf8');
    const out = encode(xml, readFileSync(args[1], 'utf8'));
    if (out !== xml) writeFileSync(args[0], out, 'utf8');
    return 0;
  }
  if (cmd === 'diff') {
    const rev = opt(args, '--rev'), to = opt(args, '--to');
    let a: string, b: string, an: string, bn: string;
    if (rev) {
      const [file] = args;
      a = toView(await atRef(file, rev)); an = `${file}@${rev}`;
      b = toView(await atRef(file, to)); bn = to ? `${file}@${to}` : file;
    } else {
      const [fa, fb] = args;
      if (!fa || !fb) return usage();
      a = toView(readFileSync(fa, 'utf8')); an = fa;
      b = toView(readFileSync(fb, 'utf8')); bn = fb;
    }
    const d = unifiedDiff(a, b, an, bn);
    process.stdout.write(d);
    return d ? 1 : 0;                      // like diff(1): 1 = differences
  }
  if (cmd === 'difftool' && args.length === 3) return difftool(args[0], args[1], args[2]);
  if (cmd === 'links' && args[0]) {
    const csv = args.includes('--csv'), yaml = args.includes('--yaml');
    if (csv && yaml) return usage();       // both would go to stdout
    const file = path.resolve(args.filter(a => a !== '--csv' && a !== '--yaml')[0]);
    if (yaml) {
      const s = await projectAt(file, undefined);
      s.warnings.forEach(w => process.stderr.write(`warning: ${w}\n`));
      // same header as `iecode io links --yaml`
      process.stdout.write(treeToYaml(buildTree(s.links, s.boxes), `# IO links of ${path.basename(file)} (working copy): ${s.links.length} link(s)`));
      return 0;
    }
    const links = await linksAt(file, undefined);
    if (csv) process.stdout.write(linksToCsv(links));
    else for (const l of links) process.stdout.write(`${l.variable}  <->  ${l.io}\n`);
    return 0;
  }
  if (cmd === 'links-diff') {
    const rev = opt(args, '--rev'), to = opt(args, '--to');
    const csv = args.includes('--csv');
    const file = args.filter(a => a !== '--csv')[0];
    if (!rev || !file) return usage();
    const changes = diffLinks(await linksAt(path.resolve(file), rev), await linksAt(path.resolve(file), to));
    if (csv) process.stdout.write(changesToCsv(changes));
    else for (const c of changes)
      process.stdout.write(`${c.kind.padEnd(8)} ${c.variable}  ${c.before ? shortPath(c.before) : ''}${c.before && c.after ? ' -> ' : ''}${c.after && c.after !== c.before ? shortPath(c.after) : ''}${c.details ? '  ' + c.details : ''}\n`);
    return changes.length ? 1 : 0;
  }
  if (cmd === 'ads' || cmd === 'ads-diff') {
    const rev = opt(args, '--rev'), to = opt(args, '--to');
    const flag = (f: string) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
    const csv = flag('--csv'), members = flag('--members');
    const [file] = args;
    if (!file || (cmd === 'ads-diff' && !rev)) return usage();
    const at = async (ref: string | undefined): Promise<AdsSymbol[]> => /\.tmc$/i.test(file)
      ? fromTmc(readFileSync(file, 'utf8'), members)
      : (await fromSourceAt(await loadPlcProject(path.resolve(file)), ref, members)).symbols;
    if (cmd === 'ads') {
      const symbols = await at(rev);
      if (csv) process.stdout.write(symbolsToCsv(symbols));
      else for (const s of symbols) process.stdout.write(`${s.name}  : ${s.type}${s.bitSize !== undefined ? '  (' + sizeText(s.bitSize) + ')' : ''}\n`);
      return 0;
    }
    const changes = diffSymbols(await at(rev), await at(to));
    if (csv) process.stdout.write(adsChangesToCsv(changes));
    else for (const c of changes) process.stdout.write(`${c.kind.padEnd(8)} ${c.name}  ${c.kind === 'changed' ? c.details : c.after ?? c.before}\n`);
    return changes.length ? 1 : 0;
  }
  return usage();
}

function usage(): number {
  console.error([
    'usage: iecode-st decode <file>',
    '       iecode-st encode <file> <view.st>',
    '       iecode-st diff <a> <b> | diff --rev <ref> [--to <ref>] <file>',
    '       iecode-st difftool <viewer> <a> <b>',
    '       iecode-st links <x.tsproj> [--csv|--yaml]',
    '       iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> [--csv]',
    '       iecode-st ads <x.plcproj|x.tmc> [--rev <ref>] [--members] [--csv]',
    '       iecode-st ads-diff --rev <ref> [--to <ref>] <x.plcproj> [--members] [--csv]',
  ].join('\n'));
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code), e => {
  console.error(`iecode-st: ${(e as Error).message}`);
  process.exit(3);
});
