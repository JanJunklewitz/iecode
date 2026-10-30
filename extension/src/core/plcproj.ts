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

// ---------- project settings (PLC project properties: Common / Library) ----------

export type SettingKey = 'Title' | 'Company' | 'ProjectVersion' | 'Author' | 'Description' | 'Released' | 'DefaultNamespace' | 'Placeholder' | 'CompilerDefines';

/** The settings the project settings editor shows, in the order of TwinCAT's property page. */
export const PROJECT_SETTINGS: { key: SettingKey; label: string; hint: string; kind?: 'bool' | 'multiline' }[] = [
  { key: 'Company', label: 'Company', hint: 'Library vendor. Title, Company and Version together make the project a library.' },
  { key: 'Title', label: 'Title', hint: 'Library name as other projects reference it.' },
  { key: 'ProjectVersion', label: 'Version', hint: 'Library version, e.g. 1.2.0 or 1.2.0.0.' },
  { key: 'Released', label: 'Released', hint: 'Marks the library as released; TwinCAT warns before a released library is changed.', kind: 'bool' },
  { key: 'DefaultNamespace', label: 'Default namespace', hint: 'Namespace of the library\'s objects in referencing projects. Empty: the title.' },
  { key: 'Placeholder', label: 'Placeholder', hint: 'Placeholder name referencing projects resolve. Empty: the title.' },
  { key: 'Author', label: 'Author', hint: '' },
  { key: 'Description', label: 'Description', hint: '', kind: 'multiline' },
  { key: 'CompilerDefines', label: 'Compiler defines', hint: 'Comma-separated, for {IF defined(...)} pragmas.' },
];

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inner range of the main <PropertyGroup> (the one with <Name>, without a Condition). */
function mainGroup(text: string): { start: number; end: number } {
  const re = /<PropertyGroup>([\s\S]*?)<\/PropertyGroup>/g;
  let first: { start: number; end: number } | undefined;
  for (let m; (m = re.exec(text));) {
    const g = { start: m.index + '<PropertyGroup>'.length, end: m.index + m[0].length - '</PropertyGroup>'.length };
    if (/<Name>/.test(m[1])) return g;
    first ??= g;
  }
  if (!first) throw new Error('Not a PLC project (no <PropertyGroup>)');
  return first;
}

/** A whole line with one setting: indent, value (undefined: <X />), line end. */
const settingRe = (key: SettingKey) => new RegExp(`^([ \\t]*)<${key}(?:\\s*/>|>([\\s\\S]*?)</${key}>)[ \\t]*(\\r?\\n)?`, 'm');

/** Current values of the settings ('' when not set). */
export function readProjectSettings(text: string): Record<SettingKey, string> {
  const { start, end } = mainGroup(text);
  const inner = text.slice(start, end);
  const out = {} as Record<SettingKey, string>;
  for (const s of PROJECT_SETTINGS) out[s.key] = unescapeXml(settingRe(s.key).exec(inner)?.[2] ?? '');
  return out;
}

/** Why a value can't be written, or undefined. */
export function checkSetting(key: SettingKey, value: string): string | undefined {
  const v = value.trim();
  if (key === 'ProjectVersion' && v && !/^\d+(\.\d+){1,3}$/.test(v)) return 'Version: two to four numbers, e.g. 1.2.0';
  if (key === 'Released' && v && v !== 'true' && v !== 'false') return 'Released: true or false';
  if ((key === 'DefaultNamespace' || key === 'Placeholder') && v && !/^[A-Za-z_][\w.]*$/.test(v)) return `${key === 'Placeholder' ? 'Placeholder' : 'Default namespace'}: letters, digits, _ and . only`;
  return undefined;
}

/**
 * The project file with the given settings changed: values replaced in place, new ones added at the end of the
 * main property group with its indentation, empty ones removed. Everything else stays byte-identical.
 */
export function setProjectSettings(text: string, values: Partial<Record<SettingKey, string>>): string {
  const eol = eolOf(text);
  const { start, end } = mainGroup(text);
  let inner = text.slice(start, end);
  for (const [key, raw] of Object.entries(values) as [SettingKey, string][]) {
    const problem = checkSetting(key, raw);
    if (problem) throw new Error(problem);
    const value = key === 'Description' ? raw.replace(/\r?\n/g, eol).trim() : raw.trim();
    const m = settingRe(key).exec(inner);
    if (m) {
      if ((m[2] === undefined ? '' : unescapeXml(m[2])) === value) continue;
      const line = value === '' ? '' : `${m[1]}<${key}>${escapeXml(value)}</${key}>${m[3] ?? ''}`;
      inner = inner.slice(0, m.index) + line + inner.slice(m.index + m[0].length);
    } else if (value !== '') {
      const indent = /^([ \t]*)<\w/m.exec(inner)?.[1] ?? '    ';
      const at = inner.lastIndexOf('\n') + 1;   // before the indentation of </PropertyGroup>
      inner = inner.slice(0, at) + `${indent}<${key}>${escapeXml(value)}</${key}>${eol}` + inner.slice(at);
    }
  }
  return text.slice(0, start) + inner + text.slice(end);
}
