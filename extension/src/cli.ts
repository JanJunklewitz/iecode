#!/usr/bin/env node
// iecode-st decode <file.TcPOU>            -> print ST view
// iecode-st encode <file.TcPOU> <view.st>  -> splice view back into the object file
// Usable as a git textconv:  git config diff.iecode-st.textconv "iecode-st decode"
import { readFileSync, writeFileSync } from 'fs';
import { decode, encode } from './model';

const [cmd, file, view] = process.argv.slice(2);
try {
  if (cmd === 'decode' && file) process.stdout.write(decode(readFileSync(file, 'utf8')));
  else if (cmd === 'encode' && file && view) {
    const xml = readFileSync(file, 'utf8');
    const out = encode(xml, readFileSync(view, 'utf8'));
    if (out !== xml) writeFileSync(file, out, 'utf8');
  } else {
    console.error('usage: iecode-st decode <file>\n       iecode-st encode <file> <view.st>');
    process.exit(2);
  }
} catch (e) {
  console.error(`iecode-st: ${(e as Error).message}`);
  process.exit(1);
}
