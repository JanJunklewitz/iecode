// The language model tools the extension registers with Copilot Chat, as data. Pure: no vscode.
// package.json (contributes.languageModelTools) declares the same names; a test keeps the two in step.

export const LM_TOOL_NAMES = [
  'iecode_ads_symbols',
  'iecode_ads_watch',
  'iecode_ads_read',
  'iecode_ads_scope',
  'iecode_ads_write',
  'iecode_ads_wait',
  'iecode_ads_config',
  'iecode_ads_preset',
] as const;

export type LmToolName = (typeof LM_TOOL_NAMES)[number];

/** One handler per declared tool; the type makes a missing or an extra entry a compile error. */
export type LmToolTable<T> = Record<LmToolName, T>;

/** The [name, handler] pairs in declaration order, ready to register. */
export function lmToolEntries<T>(table: LmToolTable<T>): [LmToolName, T][] {
  return LM_TOOL_NAMES.map(n => [n, table[n]]);
}
