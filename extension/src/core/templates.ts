// Creates new TwinCAT object files and member sections, formatted like TwinCAT XAE writes them
// (CRLF line endings, UTF-8 with BOM, fresh GUIDs).

import { randomUUID } from 'crypto';
import { decode, encode, parseView } from '../model';
import { escapeAttr, toCdata } from '../xml';

export type NewObjectKind =
  | 'FUNCTION_BLOCK' | 'PROGRAM' | 'FUNCTION' | 'INTERFACE'
  | 'STRUCT' | 'ENUM' | 'UNION' | 'ALIAS' | 'GVL';

export interface NewObjectOptions {
  extends?: string;
  implements?: string[];
  /** FUNCTION return type, ALIAS base type, ENUM base type. */
  type?: string;
  abstract?: boolean;
  final?: boolean;
  /** GVL: add {attribute 'qualified_only'} (default true). */
  qualifiedOnly?: boolean;
  /** TwinCAT version written into ProductVersion. */
  productVersion?: string;
}

export const FILE_EXT: Record<NewObjectKind, string> = {
  FUNCTION_BLOCK: '.TcPOU', PROGRAM: '.TcPOU', FUNCTION: '.TcPOU', INTERFACE: '.TcIO',
  STRUCT: '.TcDUT', ENUM: '.TcDUT', UNION: '.TcDUT', ALIAS: '.TcDUT', GVL: '.TcGVL',
};

/** Usual name prefixes, used as defaults in the wizard. */
export const NAME_PREFIX: Record<NewObjectKind, string> = {
  FUNCTION_BLOCK: 'FB_', PROGRAM: 'PRG_', FUNCTION: 'F_', INTERFACE: 'I_',
  STRUCT: 'ST_', ENUM: 'E_', UNION: 'U_', ALIAS: 'T_', GVL: 'GVL_',
};

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const guid = () => `{${randomUUID()}}`;

export function declaration(kind: NewObjectKind, name: string, o: NewObjectOptions = {}): string {
  const mods = `${o.abstract ? 'ABSTRACT ' : ''}${o.final ? 'FINAL ' : ''}`;
  const ext = o.extends ? ` EXTENDS ${o.extends}` : '';
  const impl = o.implements?.length ? ` IMPLEMENTS ${o.implements.join(', ')}` : '';
  switch (kind) {
    case 'FUNCTION_BLOCK':
      return `FUNCTION_BLOCK ${mods}${name}${ext}${impl}\nVAR_INPUT\nEND_VAR\nVAR_OUTPUT\nEND_VAR\nVAR\nEND_VAR\n`;
    case 'PROGRAM':
      return `PROGRAM ${name}\nVAR\nEND_VAR\n`;
    case 'FUNCTION':
      return `FUNCTION ${name} : ${o.type || 'BOOL'}\nVAR_INPUT\nEND_VAR\nVAR\nEND_VAR\n`;
    case 'INTERFACE':
      return `INTERFACE ${name}${ext}\n`;
    case 'STRUCT':
      return `TYPE ${name} :\nSTRUCT\nEND_STRUCT\nEND_TYPE\n`;
    case 'UNION':
      return `TYPE ${name} :\nUNION\nEND_UNION\nEND_TYPE\n`;
    case 'ENUM':
      return `{attribute 'qualified_only'}\n{attribute 'strict'}\nTYPE ${name} :\n(\n\tNone := 0\n)${o.type ? ' ' + o.type : ''};\nEND_TYPE\n`;
    case 'ALIAS':
      return `TYPE ${name} : ${o.type || 'INT'};\nEND_TYPE\n`;
    case 'GVL':
      return `${o.qualifiedOnly === false ? '' : "{attribute 'qualified_only'}\n"}VAR_GLOBAL\nEND_VAR\n`;
  }
}

/** Complete XML of a new object file (CRLF, BOM). */
export function newObjectXml(kind: NewObjectKind, name: string, o: NewObjectOptions = {}): string {
  if (!IDENT_RE.test(name)) throw new Error(`'${name}' is not a valid IEC 61131-3 identifier`);
  const decl = toCdata(declaration(kind, name, o));
  const n = escapeAttr(name);
  const id = guid();
  let body: string;
  if (kind === 'FUNCTION_BLOCK' || kind === 'PROGRAM' || kind === 'FUNCTION') {
    body = `  <POU Name="${n}" Id="${id}" SpecialFunc="None">\n    <Declaration>${decl}</Declaration>\n    <Implementation>\n      <ST><![CDATA[]]></ST>\n    </Implementation>\n  </POU>`;
  } else if (kind === 'INTERFACE') {
    body = `  <Itf Name="${n}" Id="${id}">\n    <Declaration>${decl}</Declaration>\n  </Itf>`;
  } else if (kind === 'GVL') {
    body = `  <GVL Name="${n}" Id="${id}">\n    <Declaration>${decl}</Declaration>\n  </GVL>`;
  } else {
    body = `  <DUT Name="${n}" Id="${id}">\n    <Declaration>${decl}</Declaration>\n  </DUT>`;
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1" ProductVersion="${o.productVersion ?? '3.1.4024.12'}">\n${body}\n</TcPlcObject>`;
  return '﻿' + xml.replace(/\r?\n/g, '\r\n');
}

export type Access = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL';

export interface MethodSpec { name: string; returnType?: string; access?: Access; abstract?: boolean }
export interface PropertySpec { name: string; type: string; access?: Access; get?: boolean; set?: boolean }

/** View sections (the plain-ST format of the editor) for a new member. */
export function methodSection(m: MethodSpec, isInterface = false): string {
  const head = `METHOD ${isInterface || !m.access ? '' : m.access + ' '}${m.abstract ? 'ABSTRACT ' : ''}${m.name}${m.returnType ? ' : ' + m.returnType : ''}`;
  return `//==== METHOD ${m.name} ====\n${head}\nVAR_INPUT\nEND_VAR\n` + (isInterface ? '' : `//---- IMPLEMENTATION ----\n`);
}

export function propertySection(p: PropertySpec, isInterface = false): string {
  const acc = (kind: 'GET' | 'SET') => `//==== ${kind} ${p.name} ====\n` + (isInterface ? '' : `VAR\nEND_VAR\n//---- IMPLEMENTATION ----\n`);
  return `//==== PROPERTY ${p.name} ====\nPROPERTY ${isInterface || !p.access ? '' : p.access + ' '}${p.name} : ${p.type}\n`
    + (p.get !== false ? acc('GET') : '') + (p.set ? acc('SET') : '');
}

export const actionSection = (name: string) => `//==== ACTION ${name} ====\n//---- IMPLEMENTATION ----\n`;

/** Adds member sections to an object file, returns the new XML (new GUIDs; nothing else touched). */
export function addSections(xml: string, sections: string): string {
  const bom = xml.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const src = bom ? xml.slice(1) : xml;
  const view = decode(src);
  const existing = new Set(parseView(view).map(s => `${s.kind}:${s.name}`.toLowerCase()));
  for (const s of parseView(sections)) {
    if (s.kind !== 'MAIN' && existing.has(`${s.kind}:${s.name}`.toLowerCase()))
      throw new Error(`${s.kind.toLowerCase()} ${s.name} already exists`);
  }
  const joined = view.endsWith('\n') || view === '' ? view + sections : view + '\n' + sections;
  return bom + encode(src, joined);
}

/**
 * Sections that implement the given interfaces: every method and property of the interface
 * (and of interfaces it extends, if provided by the resolver) as stubs. Members that already exist are skipped.
 */
export function interfaceStubs(interfaceXmls: string[], existingView = ''): string {
  const have = new Set(parseView(existingView).map(s => `${s.kind}:${s.name}`.toLowerCase()));
  let out = '';
  for (const raw of interfaceXmls) {
    const view = decode(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    for (const s of parseView(view)) {
      if (s.kind === 'MAIN' || have.has(`${s.kind}:${s.name}`.toLowerCase())) continue;
      have.add(`${s.kind}:${s.name}`.toLowerCase());
      const decl = (s.decl ?? '').replace(/\n$/, '');
      if (s.kind === 'METHOD') {
        out += `//==== METHOD ${s.name} ====\n${decl.replace(/^(\s*METHOD\s+)(?!PUBLIC|PRIVATE|PROTECTED|INTERNAL)/i, '$1PUBLIC ')}\n//---- IMPLEMENTATION ----\n`;
      } else if (s.kind === 'PROPERTY') {
        out += `//==== PROPERTY ${s.name} ====\n${decl.replace(/^(\s*PROPERTY\s+)(?!PUBLIC|PRIVATE|PROTECTED|INTERNAL)/i, '$1PUBLIC ')}\n`;
      } else if (s.kind === 'GET' || s.kind === 'SET') {
        out += `//==== ${s.kind} ${s.name} ====\nVAR\nEND_VAR\n//---- IMPLEMENTATION ----\n`;
      }
    }
  }
  return out;
}
