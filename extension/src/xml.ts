// Minimal, offset-preserving XML scanner for TwinCAT PLC object files.
// We never re-serialize the document: edits are applied as string splices on
// the original text, so everything we don't touch stays byte-identical.

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  start: number;          // offset of '<'
  end: number;            // offset after closing '>' (of end tag or self-closing tag)
  innerStart: number;     // offset after start tag '>'
  innerEnd: number;       // offset of end tag '<' (== innerStart for self-closing)
  children: XNode[];
  cdata?: { start: number; end: number; text: string }[]; // CDATA sections directly inside
  parent?: XNode;
}

export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, start: 0, end: src.length, innerStart: 0, innerEnd: src.length, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<![CDATA[', lt)) {
      const close = src.indexOf(']]>', lt + 9);
      if (close < 0) throw new Error(`Unterminated CDATA at ${lt}`);
      const top = stack[stack.length - 1];
      (top.cdata ??= []).push({ start: lt, end: close + 3, text: src.slice(lt + 9, close) });
      i = close + 3;
    } else if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4);
      if (close < 0) throw new Error(`Unterminated comment at ${lt}`);
      i = close + 3;
    } else if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const close = src.indexOf('>', lt);
      i = close + 1;
    } else if (src[lt + 1] === '/') {
      const close = src.indexOf('>', lt);
      const name = src.slice(lt + 2, close).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Mismatched </${name}> at ${lt}`);
      node.innerEnd = lt;
      node.end = close + 1;
      i = close + 1;
    } else {
      const close = findTagEnd(src, lt);
      const selfClosing = src[close - 1] === '/';
      const body = src.slice(lt + 1, selfClosing ? close - 1 : close);
      const m = /^([^\s/>]+)/.exec(body)!;
      const attrs: Record<string, string> = {};
      const re = /([^\s=]+)\s*=\s*"([^"]*)"/g;
      let a: RegExpExecArray | null;
      while ((a = re.exec(body.slice(m[1].length)))) attrs[a[1]] = unescapeAttr(a[2]);
      const parent = stack[stack.length - 1];
      const node: XNode = { name: m[1], attrs, start: lt, end: close + 1, innerStart: close + 1, innerEnd: close + 1, children: [], parent };
      parent.children.push(node);
      if (!selfClosing) stack.push(node);
      i = close + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

function findTagEnd(src: string, from: number): number {
  let q = false;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === '"') q = !q;
    else if (c === '>' && !q) return j;
  }
  throw new Error(`Unterminated tag at ${from}`);
}

const unescapeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** CDATA payload of a node (concatenated if split around "]]>"). null when no CDATA present. */
export function cdataText(n: XNode): string | null {
  if (!n.cdata?.length) return null;
  return n.cdata.map(c => c.text).join('');
}

/** Encode text as CDATA, splitting any embedded "]]>". */
export function toCdata(text: string): string {
  return '<![CDATA[' + text.split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

export const child = (n: XNode, name: string) => n.children.find(c => c.name === name);
