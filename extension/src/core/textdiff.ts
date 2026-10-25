// Line diff (Myers, O((N+M)·D)) and unified-diff output, used to compare ST views on the command line.

export type DiffOp = { op: ' ' | '-' | '+'; text: string; a: number; b: number };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1)! : v.get(k - 1)! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // backtrack
  const ops: DiffOp[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ op: ' ', text: a[x], a: x, b: y }); }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ op: '+', text: b[y], a: x, b: y }); }
      else { x--; ops.push({ op: '-', text: a[x], a: x, b: y }); }
    }
  }
  return ops.reverse();
}

/** Unified diff with `context` lines around changes; empty string if equal. */
export function unifiedDiff(aText: string, bText: string, aName: string, bName: string, context = 3): string {
  const a = aText.replace(/\r\n/g, '\n').split('\n'), b = bText.replace(/\r\n/g, '\n').split('\n');
  const ops = diffLines(a, b);
  if (!ops.some(o => o.op !== ' ')) return '';
  const out = [`--- ${aName}`, `+++ ${bName}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === ' ') { i++; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    // extend the hunk while changes are closer than 2*context lines
    for (let j = i; j < ops.length; j++) {
      if (ops[j].op !== ' ') end = j;
      else if (j - end > 2 * context) break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    const hunk = ops.slice(start, stop);
    const aStart = hunk.find(o => o.op !== '+')?.a ?? hunk[0].a;
    const bStart = hunk.find(o => o.op !== '-')?.b ?? hunk[0].b;
    const aLen = hunk.filter(o => o.op !== '+').length, bLen = hunk.filter(o => o.op !== '-').length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const o of hunk) out.push(o.op + o.text);
    i = stop;
  }
  return out.join('\n') + '\n';
}
