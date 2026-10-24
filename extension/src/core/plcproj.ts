// Text-level edits of a .plcproj: add / remove / rename object and folder entries.
// The file is never re-serialized, so formatting, BOM and line endings stay as TwinCAT wrote them.

const eolOf = (s: string) => (s.includes('\r\n') ? '\r\n' : '\n');
const win = (rel: string) => rel.replace(/\//g, '\\');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Path as TwinCAT writes it in Include="…" (backslashes), XML-escaped. */
const includeValue = (rel: string) => win(rel).replace(/&/g, '&amp;');

function insertIntoGroup(text: string, element: string, entry: (indent: string, eol: string) => string): string {
  const eol = eolOf(text);
  // after the last existing element of this kind
  const re = new RegExp(`(^[ \\t]*)<${element}\\s+Include="[^"]*"\\s*(?:/>|>[\\s\\S]*?</${element}>)`, 'gm');
  let last: RegExpExecArray | null = null;
  for (let m; (m = re.exec(text));) last = m;
  if (last) {
    const at = last.index + last[0].length;
    return text.slice(0, at) + eol + entry(last[1], eol) + text.slice(at);
  }
  // otherwise a new ItemGroup before </Project>
  const close = text.lastIndexOf('</Project>');
  if (close < 0) throw new Error('Not a .plcproj (no </Project>)');
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  const group = `  <ItemGroup>${eol}${entry('    ', eol)}${eol}  </ItemGroup>${eol}`;
  return text.slice(0, lineStart) + group + text.slice(lineStart);
}

export function hasCompile(text: string, rel: string): boolean {
  return new RegExp(`<Compile\\s+Include="${esc(includeValue(rel))}"`, 'i').test(text);
}

/** Adds <Compile Include="…"><SubType>Code</SubType></Compile>. No-op if already present. */
export function addCompile(text: string, rel: string): string {
  if (hasCompile(text, rel)) return text;
  return insertIntoGroup(text, 'Compile', (ind, eol) =>
    `${ind}<Compile Include="${includeValue(rel)}">${eol}${ind}  <SubType>Code</SubType>${eol}${ind}</Compile>`);
}

/** Adds <Folder Include="…" /> for the folder and all its parents that are missing. */
export function addFolder(text: string, rel: string): string {
  const parts = rel.replace(/\/$/, '').split('/');
  for (let i = 1; i <= parts.length; i++) {
    const f = parts.slice(0, i).join('/');
    if (new RegExp(`<Folder\\s+Include="${esc(includeValue(f))}\\\\?"`, 'i').test(text)) continue;
    text = insertIntoGroup(text, 'Folder', ind => `${ind}<Folder Include="${includeValue(f)}" />`);
  }
  return text;
}

/** Removes the Compile entry of an object (and its whole element). */
export function removeCompile(text: string, rel: string): string {
  const re = new RegExp(`^[ \\t]*<Compile\\s+Include="${esc(includeValue(rel))}"\\s*(?:/>|>[\\s\\S]*?</Compile>)\\r?\\n?`, 'im');
  return text.replace(re, '');
}

/** Removes a folder entry and every Compile / Folder entry below it. */
export function removeFolder(text: string, rel: string): string {
  const prefix = esc(includeValue(rel));
  return text
    .replace(new RegExp(`^[ \\t]*<Compile\\s+Include="${prefix}\\\\[^"]*"\\s*(?:/>|>[\\s\\S]*?</Compile>)\\r?\\n?`, 'gim'), '')
    .replace(new RegExp(`^[ \\t]*<Folder\\s+Include="${prefix}(?:\\\\[^"]*)?"\\s*/>\\r?\\n?`, 'gim'), '');
}

/** Renames / moves an entry: object path or folder prefix. */
export function renamePath(text: string, from: string, to: string): string {
  const f = esc(includeValue(from));
  return text.replace(new RegExp(`(<(?:Compile|Folder)\\s+Include=")${f}(\\\\[^"]*)?(\\\\?")`, 'gi'),
    (_m, a: string, rest: string | undefined, b: string) => a + includeValue(to) + (rest ?? '') + b);
}

/**
 * Renames an object inside its file: the Name attribute, the identifier in the declaration header,
 * and LineIds names (FB_X and FB_X.Member). Other references in the project are not changed.
 */
export function renameObjectXml(xml: string, oldName: string, newName: string): string {
  const o = esc(oldName);
  return xml
    .replace(new RegExp(`(<(?:POU|DUT|GVL|Itf)\\s+Name=")${o}(")`), `$1${newName}$2`)
    .replace(new RegExp(`(<Declaration><!\\[CDATA\\[(?:\\s*\\{[^}]*\\}\\s*)*\\s*(?:FUNCTION_BLOCK|PROGRAM|FUNCTION|INTERFACE|TYPE)\\s+(?:ABSTRACT\\s+|FINAL\\s+|INTERNAL\\s+|PUBLIC\\s+)*)${o}\\b`, 'i'), `$1${newName}`)
    .replace(new RegExp(`(<LineIds\\s+Name=")${o}((?:\\.[^"]*)?")`, 'g'), `$1${newName}$2`);
}
