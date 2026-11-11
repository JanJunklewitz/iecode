// Texts of the AI write results that more than one module needs. Pure: no imports.

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
