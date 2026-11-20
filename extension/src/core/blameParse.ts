// Parser of `git blame --porcelain`. Kept free of git access so that git.ts and blame.ts do not import each other.

export interface LineBlame {
  commit: string;
  author: string;
  time: number;
  summary: string;
  uncommitted: boolean;
  /** Line number and path in `commit` itself (porcelain header and `filename` line), not in the working file. */
  origLine: number;
  origPath: string;
}

const ZERO = /^0+$/;

/** Parses `git blame --porcelain`; the result is indexed by (final) XML line - 1. */
export function parseBlamePorcelain(out: string): LineBlame[] {
  const result: LineBlame[] = [];
  // git prints author, summary and filename only with the first line of a commit, so all three are kept per commit
  const byCommit = new Map<string, { author: string; time: number; summary: string; filename: string }>();
  let head: { commit: string; orig: number; final: number } | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      if (head) {
        const info = byCommit.get(head.commit) ?? { author: '', time: 0, summary: '', filename: '' };
        const uncommitted = ZERO.test(head.commit);
        result[head.final - 1] = {
          commit: head.commit, author: uncommitted ? 'Not committed yet' : info.author, time: info.time, summary: info.summary,
          uncommitted, origLine: head.orig, origPath: info.filename,
        };
      }
      head = undefined;
      continue;
    }
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (h) {
      head = { commit: h[1], orig: Number(h[2]), final: Number(h[3]) };
      if (!byCommit.has(h[1])) byCommit.set(h[1], { author: '', time: 0, summary: '', filename: '' });
      continue;
    }
    if (!head) continue;
    const info = byCommit.get(head.commit)!;
    if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('author-time ')) info.time = Number(line.slice(12));
    else if (line.startsWith('summary ')) info.summary = line.slice(8);
    else if (line.startsWith('filename ')) info.filename = line.slice(9);
  }
  return result;
}
