// Global_Version.TcGVL: the constant TwinCAT generates from a library's title and version
// (stLibVersion_<Title> : ST_LibVersion). TwinCAT regenerates it only on build, so IECode writes it whenever the
// title or version change in the project settings, and creates it (with its .plcproj entry) when it is missing.

import { guid } from './templates';
import { addCompile, addFolder, hasCompile } from './plcproj';

/** Where TwinCAT puts it, relative to the .plcproj folder. */
export const GLOBAL_VERSION_REL = 'Version/Global_Version.TcGVL';

/** stLibVersion_ plus the title with everything but letters, digits and _ as _ ("My Lib 2" → stLibVersion_My_Lib_2). */
export const versionConstant = (title: string) => 'stLibVersion_' + title.trim().replace(/[^A-Za-z0-9_]/g, '_');

/** Major, minor, build, revision (missing parts 0). */
export function versionParts(version: string): [number, number, number, number] {
  const n = version.trim().split('.').map(Number);
  if (n.length < 2 || n.length > 4 || n.some(x => !Number.isInteger(x) || x < 0)) throw new Error(`not a version: ${version}`);
  return [n[0], n[1], n[2] ?? 0, n[3] ?? 0];
}

/** The declaration line, as TwinCAT writes it (four-part sVersion). */
export function versionLine(title: string, version: string): string {
  const [ma, mi, bu, re] = versionParts(version);
  return `${versionConstant(title)} : ST_LibVersion := (iMajor := ${ma}, iMinor := ${mi}, iBuild := ${bu}, iRevision := ${re}, nFlags := 0, sVersion := '${ma}.${mi}.${bu}.${re}');`;
}

/** A new Global_Version.TcGVL (no BOM, CRLF, tabs, like TwinCAT). */
export function newGlobalVersion(title: string, version: string, id = guid()): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TcPlcObject Version="1.1.0.1">',
    `  <GVL Name="Global_Version" Id="${id}">`,
    `    <Declaration><![CDATA[{attribute 'TcGenerated'}`,
    `{attribute 'no-analysis'}`,
    `{attribute 'linkalways'}`,
    '// This function has been automatically generated from the project information.',
    'VAR_GLOBAL CONSTANT',
    `\t{attribute 'const_non_replaced'}`,
    `\t${versionLine(title, version)}`,
    'END_VAR',
    ']]></Declaration>',
    '  </GVL>',
    '</TcPlcObject>',
    '',
  ].join('\r\n');
}

/** The file with its stLibVersion_ line replaced (indentation and everything else kept). */
export function updateGlobalVersion(xml: string, title: string, version: string): string {
  const re = /^([ \t]*)stLibVersion_\w*\s*:\s*ST_LibVersion\b[^\r\n]*/m;
  if (!re.test(xml)) throw new Error('Global_Version.TcGVL has no stLibVersion_ constant');
  return xml.replace(re, (_m, ind: string) => ind + versionLine(title, version));
}

/** The .plcproj with the Version folder and the Global_Version entry (unchanged when it is there). */
export function addGlobalVersionEntry(plcproj: string, rel = GLOBAL_VERSION_REL): string {
  if (hasCompile(plcproj, rel)) return plcproj;
  return addCompile(addFolder(plcproj, rel.replace(/\/[^/]*$/, '')), rel);
}

/** The Global_Version entry of a .plcproj (posix, relative), wherever the project keeps it. */
export function globalVersionRel(plcproj: string): string | undefined {
  const m = /<Compile\s+Include="((?:[^"]*\\)?Global_Version\.TcGVL)"/i.exec(plcproj);
  return m ? m[1].replace(/\\/g, '/') : undefined;
}
