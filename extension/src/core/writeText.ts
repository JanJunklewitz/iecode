// Texts of the AI write results that more than one module needs. Pure: no imports.

export interface WriteItem { symbol: string; value: string }
export type WriteItemResult =
  | { symbol: string; status: 'written'; readBack: string | null; readBackError?: string }
  | { symbol: string; status: 'notWritten'; reason: string }
  | { symbol: string; status: 'unknown'; reason: string };

/** Strips one trailing dot, so a reason reads inside a sentence of ours. */
export const sentence = (s: string): string => s.replace(/\.$/, '');

const truth = (s: string, words: boolean): boolean | undefined => {
  const t = s.trim().toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  if (!words && t === '1') return true;
  if (!words && t === '0') return false;
  return undefined;
};

/**
 * True when a BOOL read back as the opposite of what was written: ADS reports an error code for a rejected write,
 * so after an accepted write a differing BOOL is the PLC's doing. Everything else is false (integers, REAL, enums,
 * strings keep the plain wording).
 * `baseType` is the resolved base type when known: it must be BOOL, then 1/0 count as BOOL literals too. Without
 * a type only the words TRUE and FALSE prove a BOOL (an INT 1 read back as 0 is not a BOOL change).
 */
export function readBackChanged(requested: string, readBack: string, baseType?: string): boolean {
  if (baseType !== undefined && baseType.trim().toUpperCase() !== 'BOOL') return false;
  const words = baseType === undefined;
  const a = truth(requested, words);
  const b = truth(readBack, words);
  return a !== undefined && b !== undefined && a !== b;
}

/** AI-supplied text on one line: line breaks become literal \r and \n so they cannot fake extra lines. */
const oneLine = (s: string): string => s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

/** The dialog text; one item: "Write S := V on <where>?<note>", several: header, then one line per item. */
export function confirmMessage(items: readonly WriteItem[], where: string, note: string): string {
  const line = (i: WriteItem): string => `${oneLine(i.symbol)} := ${oneLine(i.value)}`;
  if (items.length === 1) return `Write ${line(items[0])} on ${where}?${note}`;
  return [`Write ${items.length} values on ${where}?${note}`, ...items.map(line)].join('\n');
}

/** True when any item of a done result is not 'written'. */
export const doneIsError = (results: readonly WriteItemResult[]): boolean => results.some(r => r.status !== 'written');

/** Batch lines for a `done` result; `items` are the requested items (same order as `results`). */
export function doneText(items: readonly WriteItem[], results: readonly WriteItemResult[]): string {
  const count = (s: WriteItemResult['status']): number => results.filter(r => r.status === s).length;
  const parts: [number, string][] = [[count('written'), 'written'], [count('notWritten'), 'not written'], [count('unknown'), 'outcome unknown']];
  const header = results.length === 1
    ? `Write sent: ${count('written') ? '1 written' : count('notWritten') ? '1 not written' : 'outcome unknown'}.`
    : `Sent in one ADS request (${results.length} writes): ${parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(', ')}.`;
  let noReadBack = false;
  const lines = results.map((r, k) => {
    const name = oneLine(r.symbol);
    if (r.status === 'notWritten') return `${name}: not written: ${oneLine(sentence(r.reason))}`;
    if (r.status === 'unknown') return `${name}: outcome unknown: ${oneLine(sentence(r.reason))}`;
    if (r.readBack === null) {
      noReadBack = true;
      return `${name}: written, but it could not be read back: ${oneLine(sentence(r.readBackError ?? 'unknown error'))}`;
    }
    const wanted = items[k]?.value;
    if (wanted !== undefined && readBackChanged(wanted, r.readBack)) {
      return `${name}: written (accepted by ADS), but then reads back as ${oneLine(r.readBack)}, not ${oneLine(wanted)}: the PLC changed it after the write`;
    }
    return `${name}: written, reads back as ${oneLine(r.readBack)} (the PLC may change it again)`;
  });
  const trailers = [
    ...(noReadBack ? ['Read the items without a read-back before acting on their values.'] : []),
    ...(count('unknown') ? ['Do not write the unknown items again on your own; read them and ask the user.'] : []),
  ];
  return [header, ...lines, ...trailers].join('\n');
}
