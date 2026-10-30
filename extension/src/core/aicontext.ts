// Context for AI chats (GitHub Copilot Chat, Claude Code): a piece of ST or a visualization element as a
// Markdown prompt with where it comes from, optionally after a comment of the user ("Comment for AI…").

import { outline } from '../model';
import { Visu, elementToText, flatten, visuToText } from './tcvis';

export interface AiContext {
  what: string;   // e.g. "METHOD FB_Motor.Start", "Button bStart (GenElemInst_3) of visualization VI_Main"
  file: string;   // workspace-relative path
  lang: string;   // code fence language
  code: string;
}

/** The prompt text: comment, then where the code is from, then the code in a fence longer than any inside. */
export function aiPrompt(c: AiContext, comment = ''): string {
  const ticks = Math.max(3, ...[...c.code.matchAll(/`{3,}/g)].map(m => m[0].length + 1));
  const fence = '`'.repeat(ticks);
  const head = comment.trim() ? [comment.trim(), ''] : [];
  return [...head, `${c.what} in \`${c.file}\`:`, fence + c.lang, c.code.replace(/\s+$/, ''), fence, ''].join('\n');
}

/** An element of a visualization (with its children) as YAML summary, or the whole visualization without `guid`. */
export function visuAiContext(v: Visu, file: string, guid?: string): AiContext | undefined {
  if (!guid) return { what: `Visualization ${v.name}`, file, lang: 'yaml', code: visuToText(v) };
  const e = flatten(v.elements).find(x => x.guid === guid);
  if (!e) return undefined;
  return { what: `${e.kind} ${e.name || e.identifier} (${e.identifier}) of visualization ${v.name}`, file, lang: 'yaml', code: elementToText(e) };
}

/**
 * Lines `from`..`to` (0-based, inclusive) of an ST view, named by the section they start in (POU, METHOD X, ...).
 * With `from` === `to` and an empty selection, pass `whole` to take the whole section around that line.
 */
export function stAiContext(text: string, from: number, to: number, file: string, whole = false): AiContext {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const pou = file.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '');
  const heads = outline(text);
  const head = heads.filter(h => h.line <= from).pop();
  if (whole) {
    from = head ? head.line : 0;
    const next = heads.find(h => h.line > from);
    to = (next ? next.line : lines.length) - 1;
  }
  const what = head ? `${head.kind} ${pou}.${head.name}` : pou;
  return { what, file, lang: 'st', code: lines.slice(from, to + 1).join('\n') };
}
