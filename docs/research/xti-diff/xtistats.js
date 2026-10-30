// Classify what changes in PLC .xti files across git history.
// usage: node xtistats.js <maxCommitsPerFile> <file>...   (absolute paths)
// Writes xtistats.txt to the current directory: per-category totals, then one row per change key
// (commits, lines, key, sample commit subjects). The output contains commit subjects of the
// analysed repos, so run it from internal/ (git-ignored) or outside this repo.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const max = +process.argv[2];
const files = process.argv.slice(3);
const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 1 << 30, encoding: 'utf8' });

const popTo = (stack, tag) => { const i = stack.lastIndexOf(tag); if (i >= 0) stack.length = i; };

// line index -> element path ("Project/Instance/Vars/Var/Name") for every line
function pathMap(text) {
  const lines = text.split(/\r?\n/);
  const stack = [], out = new Array(lines.length), owner = new Array(lines.length), names = [];
  let cdata = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (cdata) {
      out[i] = stack.join('/') + '/#cdata';
      if (l.includes(']]>')) { cdata = false; const c = l.match(/<\/([\w.-]+)>/); if (c) popTo(stack, c[1]); }
      continue;
    }
    const m = l.match(/^\s*<(\/?)([A-Za-z_][\w.-]*)/);
    if (!m) { out[i] = stack.join('/') + '/#text'; continue; }
    const [, close, tag] = m;
    owner[i] = names[stack.length];
    if (tag === "Name" && !close) names[stack.length] = (l.match(/>([^<]*)</) || [])[1];
    if (close) { out[i] = stack.join('/') + '/' + tag + '(close)'; popTo(stack, tag); continue; }
    out[i] = stack.join('/') + '/' + tag;
    if (l.includes('<![CDATA[') && !l.includes(']]>')) cdata = true;
    const selfClose = /\/>\s*$/.test(l);
    const closedSame = new RegExp('</' + tag + '>').test(l);
    if (!selfClose && !closedSame && !cdata) { stack.push(tag); names[stack.length] = undefined; }
    else if (cdata && !closedSame) stack.push(tag);
  }
  return { paths: out.map(p => p.replace(/^\/?TcSmItem\/?/, '')), owner };
}

const attrs = l => Object.fromEntries([...l.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const text = l => (l.match(/>([^<]*)</) || [])[1];
// shorten long paths: keep first 3 and last 2 segments
const short = p => { const s = p.split('/'); return s.length <= 6 ? p : [...s.slice(0, 3), '…', ...s.slice(-2)].join('/'); };

// category of a change key ("~ path @attr,#text" / "+ path" / "- path"); noise categories start with "noise:"
// values that change on every build: owner <Name> of the changed line
const BUILD = /^(Application Timestamp|Refactory Counter|ChangeDate|GeneratedCodeSize|GlobalDataSize|to_string_function|to_wstring_function)$/;
const NOISE_ATTR = /^@(GUID|GuidA|IdA)$/;
function category(key) {
  const [op, p, what = ''] = key.split(' ');
  const leaf = p.split('/').pop();
  if (what === '(whitespace)') return 'noise:whitespace';
  if (p.startsWith('Mappings')) return 'links (out of scope)';
  if (p.includes('UnrestoredVarLinks')) return p.endsWith('UnrestoredVarLinks') && what === '@ImportTime' ? 'noise:timestamps' : 'unrestored links';
  if (op === '~' && what.split(',').every(w => NOISE_ATTR.test(w))) return 'noise:guid';
  if (/^(BitOffs|BitSize|ByteSize|GetCodeOffs|SetCodeOffs|ReturnBitSize)$/.test(leaf)) return 'layout';
  if (p.startsWith('DataTypes')) return 'embedded data types';
  if (p.includes('/DataAreas')) return 'process image symbols';
  if (p.includes('/ParameterValues') || p.includes('/Parameters')) return 'instance parameters';
  if (p.includes('/Licenses')) return 'licenses';
  if (p.includes('/Contexts') || p.includes('/TaskPouOids')) return 'tasks';
  if (/(^|\/)Instance$/.test(p) && /^@(TmcHash|LastKnownRefactorCnt)(,@(TmcHash|LastKnownRefactorCnt))?$/.test(what)) return 'metadata';
  if (p === '' && what === '@TcVersion') return 'metadata';
  if (/(^|\/)(Project|Instance|TmcDesc|CLSID|Name)$/.test(p) || p === '') return 'project / instance settings';
  return 'other';
}

const stats = new Map(); // key -> {commits:Set, lines, subjects:Set}
const cats = new Map();  // category -> {commits:Set, lines}
let commitCats;          // categories hit by the current commit
const hit = (full, c, subj, own, txt) => {
  const key = full.replace(/ (\S+)/, (_, p) => ' ' + short(p));
  let s = stats.get(key); if (!s) stats.set(key, s = { commits: new Set(), lines: 0, subjects: new Set() });
  s.commits.add(c); s.lines++; if (s.subjects.size < 4) s.subjects.add(subj);
  const cat = BUILD.test(own || "") || /^__TO_W?STRING__\d+$/.test(txt || "") ? "noise:build info" : category(full);
  let t = cats.get(cat); if (!t) cats.set(cat, t = { commits: new Set(), lines: 0 });
  t.commits.add(c); t.lines++; commitCats.add(cat);
};
let commitsTotal = 0, noiseOnly = 0; const big = [], large = [];

for (const file of files) {
  const cwd = path.dirname(file);
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const log = git(root, ['log', '--no-merges', '--format=%h%x09%s', '-n', String(max), '--', rel]).trim().split('\n').filter(Boolean);
  for (const entry of log) {
    const [c, subj] = entry.split('\t');
    let diff;
    try { diff = git(root, ['diff', '-U0', '--no-color', c + '^', c, '--', rel]); } catch { continue; }
    if (!diff) continue;
    const size = [...diff.matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)].reduce((s, h) => s + +(h[1] ?? 1) + +(h[2] ?? 1), 0);
    if (size > 150000) { big.push(c + ' ' + size + ' ' + subj); continue; }
    let oldText, newText;
    try { oldText = git(root, ['show', c + '^:' + rel]); newText = git(root, ['show', c + ':' + rel]); } catch { continue; }
    commitsTotal++; commitCats = new Set();
    const { paths: om, owner: oo } = pathMap(oldText), { paths: nm, owner: no } = pathMap(newText);
    const ol = oldText.split(/\r?\n/), nl = newText.split(/\r?\n/);
    let changed = 0;
    const tag = path.basename(path.dirname(path.dirname(path.dirname(rel)))) + ' ' + c;
    for (const h of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const a = +h[1], b = h[2] === undefined ? 1 : +h[2], cc = +h[3], d = h[4] === undefined ? 1 : +h[4];
      const n = Math.max(b, d); changed += b + d;
      for (let k = 0; k < n; k++) {
        const oi = k < b ? a - 1 + k : -1, ni = k < d ? cc - 1 + k : -1;
        if (oi >= 0 && ni >= 0 && om[oi] === nm[ni]) {
          // same element changed in place: report which attributes / text differ
          const oa = attrs(ol[oi]), na = attrs(nl[ni]);
          const keys = new Set([...Object.keys(oa), ...Object.keys(na)]);
          const diffs = [...keys].filter(x => oa[x] !== na[x]).map(x => '@' + x);
          if (text(ol[oi]) !== text(nl[ni])) diffs.push('#text');
          hit('~ ' + nm[ni] + ' ' + (diffs.join(',') || '(whitespace)'), tag, subj, no[ni], text(nl[ni]));
        } else {
          if (oi >= 0) hit('- ' + om[oi], tag, subj, oo[oi], text(ol[oi]));
          if (ni >= 0) hit('+ ' + nm[ni], tag, subj, no[ni], text(nl[ni]));
        }
      }
    }
    if (changed > 20000) large.push(tag + ' ' + changed + ' ' + subj);
    // nothing left once noise, layout, metadata and links are filtered out
    if ([...commitCats].every(x => x.startsWith('noise:') || x === 'layout' || x === 'metadata' || x === 'links (out of scope)')) noiseOnly++;
  }
  process.stderr.write('done ' + rel + ' (' + log.length + ')\n');
}

const rows = [...stats].sort((x, y) => y[1].commits.size - x[1].commits.size);
const pct = n => Math.round(100 * n / commitsTotal) + '%';
let out = 'commits analysed: ' + commitsTotal + '\ncommits with only noise/layout/metadata/links: ' + noiseOnly + ' (' + pct(noiseOnly) + ')\n\n';
out += 'categories (commits, % of commits, changed lines):\n' + [...cats].sort((x, y) => y[1].commits.size - x[1].commits.size)
  .map(([k, t]) => t.commits.size + '\t' + pct(t.commits.size) + '\t' + t.lines + '\t' + k).join('\n') + '\n\n';
out += 'skipped full rewrites (>150k changed lines):\n' + big.join('\n') + '\n\nlarge commits (>20k changed lines):\n' + large.join('\n') + '\n\n';
out += rows.map(([k, s]) => s.commits.size + '\t' + s.lines + '\t' + k + '\t| ' + [...s.subjects].join(' | ')).join('\n');
fs.writeFileSync('xtistats.txt', out);
console.log('rows', rows.length, 'commits', commitsTotal);
