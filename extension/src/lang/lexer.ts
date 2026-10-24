// Tokenizer for IEC 61131-3 Structured Text as used by TwinCAT 3.

export type TokenType = 'ident' | 'keyword' | 'number' | 'string' | 'comment' | 'pragma' | 'op' | 'section';

export interface Token {
  type: TokenType;
  text: string;
  /** Upper-case text for identifiers / keywords (ST is case-insensitive). */
  upper: string;
  offset: number;
  line: number;   // 0-based
  col: number;    // 0-based
}

export const KEYWORDS = new Set(`
ABSTRACT ACTION AND AND_THEN ARRAY AT BY CASE CONSTANT CONTINUE DO ELSE ELSIF END_ACTION END_CASE END_FOR
END_FUNCTION END_FUNCTION_BLOCK END_IF END_INTERFACE END_METHOD END_PROGRAM END_PROPERTY END_REPEAT END_STRUCT
END_TYPE END_UNION END_VAR END_WHILE EXIT EXTENDS FALSE FINAL FOR FUNCTION FUNCTION_BLOCK IF IMPLEMENTS INTERFACE
INTERNAL JMP METHOD MOD NOT OF OR OR_ELSE PERSISTENT POINTER PRIVATE PROGRAM PROPERTY PROTECTED PUBLIC REF REFERENCE
REPEAT RETAIN RETURN STRUCT SUPER THEN THIS TO TRUE TYPE UNION UNTIL VAR VAR_CONFIG VAR_EXTERNAL VAR_GLOBAL VAR_INPUT
VAR_INST VAR_IN_OUT VAR_OUTPUT VAR_STAT VAR_TEMP WHILE XOR __NEW __DELETE __QUERYINTERFACE __QUERYPOINTER __ISVALIDREF
`.trim().split(/\s+/));

export const ELEMENTARY_TYPES = new Set(`
BOOL BYTE WORD DWORD LWORD SINT USINT INT UINT DINT UDINT LINT ULINT REAL LREAL TIME LTIME DATE LDATE TIME_OF_DAY TOD
LTOD DATE_AND_TIME DT LDT STRING WSTRING ANY ANY_NUM ANY_INT ANY_REAL ANY_BIT ANY_STRING ANY_DATE XINT UXINT XWORD
PVOID HRESULT BIT
`.trim().split(/\s+/));

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
// time / date literals first (T#1s would otherwise lex as the typed integer T#1)
const NUMBER = /(?:(?:LTIME|TIME|LTOD|TOD|TIME_OF_DAY|LDATE|DATE|LDT|DT|DATE_AND_TIME|LT|T|D)#[\w:.+-]+)|(?:(?:[A-Za-z_]+#)?(?:2#[01_]+|8#[0-7_]+|16#[0-9A-Fa-f_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?))/y;
const OPS = [':=', '=>', '<>', '<=', '>=', '..', '**', '^', '(', ')', '[', ']', ',', ';', ':', '.', '+', '-', '*', '/', '<', '>', '=', '&', '#'];

/** Section headers of the IECode view (//==== METHOD X ====) are kept as single tokens. */
const SECTION = /\/\/(?:====|----) [^\n]*/y;

export function tokenize(src: string, keepTrivia = false): Token[] {
  const out: Token[] = [];
  let i = 0, line = 0, lineStart = 0;
  const push = (type: TokenType, text: string, at: number) => {
    if (keepTrivia || (type !== 'comment' && type !== 'pragma'))
      out.push({ type, text, upper: type === 'ident' || type === 'keyword' ? text.toUpperCase() : text, offset: at, line, col: at - lineStart });
  };
  const advanceLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; lineStart = ++i; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    const start = i;
    if (src.startsWith('//', i)) {
      SECTION.lastIndex = i;
      const sec = SECTION.exec(src);
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      push(sec && sec.index === i && /^\/\/(====|----) /.test(sec[0]) ? 'section' : 'comment', src.slice(i, stop), start);
      i = stop;
      continue;
    }
    if (src.startsWith('(*', i)) {
      // TwinCAT allows nested block comments.
      let depth = 0, k = i;
      while (k < src.length) {
        if (src.startsWith('(*', k)) { depth++; k += 2; }
        else if (src.startsWith('*)', k)) { depth--; k += 2; if (!depth) break; }
        else k++;
      }
      push('comment', src.slice(i, k), start);
      advanceLines(i, k);
      i = k;
      continue;
    }
    if (c === '{') {
      const k = src.indexOf('}', i);
      const stop = k < 0 ? src.length : k + 1;
      push('pragma', src.slice(i, stop), start);
      advanceLines(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') k += src[k] === '$' ? 2 : 1;
      push('string', src.slice(i, k + 1), start);
      i = k + 1;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = /[0-9]/.test(c) || /^[A-Za-z_]+#/.test(src.slice(i, i + 12)) ? NUMBER.exec(src) : null;
    if (num && num.index === i && num[0].length) {
      push('number', num[0], start);
      i += num[0].length;
      continue;
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(src);
    if (id && id.index === i) {
      const up = id[0].toUpperCase();
      push(KEYWORDS.has(up) ? 'keyword' : 'ident', id[0], start);
      i += id[0].length;
      continue;
    }
    const op = OPS.find(o => src.startsWith(o, i)) ?? c;
    push('op', op, start);
    i += op.length;
  }
  return out;
}

/** Identifier (with dotted qualifiers) at an offset, e.g. "fbMotor.Start" for the cursor on "Start". */
export function wordAt(src: string, offset: number): { word: string; qualifier: string[]; start: number; end: number } | undefined {
  const isId = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  let s = offset, e = offset;
  while (s > 0 && isId(src[s - 1])) s--;
  while (e < src.length && isId(src[e])) e++;
  if (s === e || /[0-9]/.test(src[s])) return undefined;
  const word = src.slice(s, e);
  const qualifier: string[] = [];
  let k = s;
  // walk back over ".name", "[index].", "^." so a[1].b and p^.b qualify b
  while (src[k - 1] === '.') {
    let q = k - 1;
    if (src[q - 1] === '^') q--;
    if (src[q - 1] === ']') {
      let depth = 0;
      for (q = q - 1; q >= 0; q--) {
        if (src[q] === ']') depth++;
        else if (src[q] === '[' && --depth === 0) break;
      }
      if (q < 0) break;
    }
    let p = q;
    while (p > 0 && isId(src[p - 1])) p--;
    if (p === q) break;
    qualifier.unshift(src.slice(p, q));
    k = p;
  }
  return { word, qualifier, start: s, end: e };
}
