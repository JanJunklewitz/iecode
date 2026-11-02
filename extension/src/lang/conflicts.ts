// Git conflict blocks in a text (ST view): find them and resolve one. No vscode dependency (unit tested).

export interface ConflictBlock {
  start: number;          // line of <<<<<<<
  base?: number;          // line of ||||||| (diff3 style)
  sep: number;            // line of =======
  end: number;            // line of >>>>>>>
}

export type Choice = 'current' | 'incoming' | 'both';

export function findConflicts(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const out: ConflictBlock[] = [];
  let open: Partial<ConflictBlock> | undefined;
  lines.forEach((l, i) => {
    if (/^<{7}(\s|$)/.test(l)) open = { start: i };
    else if (open && open.sep === undefined && /^\|{7}(\s|$)/.test(l)) open.base = i;
    else if (open && open.sep === undefined && /^={7}(\s|$)/.test(l)) open.sep = i;
    else if (open?.sep !== undefined && /^>{7}(\s|$)/.test(l)) { out.push({ ...open, end: i } as ConflictBlock); open = undefined; }
  });
  return out;
}

/** Lines that replace the block (start..end inclusive) for the given choice. */
export function resolveLines(lines: string[], b: ConflictBlock, choice: Choice): string[] {
  const current = lines.slice(b.start + 1, b.base ?? b.sep);
  const incoming = lines.slice(b.sep + 1, b.end);
  return choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming];
}
