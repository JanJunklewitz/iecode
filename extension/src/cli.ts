#!/usr/bin/env node
// iecode-st decode <file.TcPOU>                       -> print ST view (also usable as git textconv)
// iecode-st encode <file.TcPOU> <view.st>             -> splice view back into the object file
// iecode-st diff <a.TcPOU> <b.TcPOU>                  -> unified diff of the ST views
// iecode-st diff --rev <ref> [--to <ref>] <file>      -> ST diff against a git commit (default: working copy)
// iecode-st links <x.tsproj> [--csv]                  -> IO links of a TwinCAT project
// iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> [--csv] -> IO link changes since a commit
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { decode, encode } from './model';
import { isEncrypted } from './core/projects';
import { unifiedDiff } from './core/textdiff';
import { repoRoot, show } from './core/git';
import { changesToCsv, diffLinks, linksToCsv, shortPath } from './core/iolinks';
import { linksAt } from './core/iohistory';

const toView = (xml: string) => (isEncrypted(xml) ? '(* encrypted object *)\n' : decode(xml.replace(/^﻿/, '')));

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
  if (cmd === 'links' && args[0]) {
    const csv = args.includes('--csv');
    const links = await linksAt(path.resolve(args.filter(a => a !== '--csv')[0]), undefined);
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
  return usage();
}

function usage(): number {
  console.error([
    'usage: iecode-st decode <file>',
    '       iecode-st encode <file> <view.st>',
    '       iecode-st diff <a> <b> | diff --rev <ref> [--to <ref>] <file>',
    '       iecode-st links <x.tsproj> [--csv]',
    '       iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> [--csv]',
  ].join('\n'));
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code), e => {
  console.error(`iecode-st: ${(e as Error).message}`);
  process.exit(3);
});
