// Model of a TwinCAT Module Class file (.tmc) for the viewer: the modules with their tasks, data areas and symbols,
// and the data types. Read-only: TwinCAT writes these files on every build. Sizes are as stored (bits, tasks in ns).
//   <TcModuleClass><Vendor/><DataTypes><DataType/>…</DataTypes><Modules><Module><Contexts/><DataAreas/>…</Module></Modules></TcModuleClass>

import { parseXml, XNode } from '../xml';
import { intOf, keyOf, kid, kids, textOf, typeOf } from './adsinterface';

export interface TmcNameValue { name: string; value?: string }

export interface TmcVar {
  name: string;
  /** With ARRAY / POINTER TO / REFERENCE TO. */
  type: string;
  /** Index of the base type in `types`; undefined for types not defined in this file (BOOL, INT …). */
  ref?: number;
  bitSize?: number;
  bitOffs?: number;
  comment?: string;
  default?: string;
  /** Attributes such as {attribute 'TcLinkTo'}. */
  properties?: TmcNameValue[];
}

export interface TmcArea { no?: number; areaType?: string; name: string; contextId?: number; byteSize?: number; symbols: TmcVar[] }
export interface TmcContext { id?: number; name?: string; priority?: number; cycleTimeNs?: number }
export interface TmcParameter { name: string; type: string; ref?: number; bitSize?: number; ptcid?: string; readOnly: boolean; comment?: string }

export interface TmcModule {
  name: string;
  guid?: string;
  classFactory?: string;
  clsid?: string;
  group?: string;
  initSequence?: string;
  contexts: TmcContext[];
  interfaces: string[];
  licenses: string[];
  parameters: TmcParameter[];
  areas: TmcArea[];
  properties: TmcNameValue[];
}

export type TmcTypeKind = 'struct' | 'enum' | 'array' | 'alias' | 'other';
export interface TmcEnumValue { text: string; value?: string; comment?: string }

export interface TmcType {
  name: string;
  namespace?: string;
  guid?: string;
  kind: TmcTypeKind;
  bitSize?: number;
  comment?: string;
  /** Base of an enum or alias, element type of an array, with `baseRef` like TmcVar.ref. */
  base?: string;
  baseRef?: number;
  extends?: string;
  extendsRef?: number;
  members: TmcVar[];
  enumValues: TmcEnumValue[];
  /** Signatures: Start(nSpeed : INT) : BOOL. */
  methods: string[];
  properties: TmcNameValue[];
}

export interface TmcFile { vendor?: string; modules: TmcModule[]; types: TmcType[] }

/** Thrown for XML that isn't a module class file. */
export class NotTmcError extends Error {}

/** .tmc files are UTF-8, but older tools may have stored them as UTF-16. */
export function decodeTmc(bytes: Uint8Array): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes);
}

const nameValues = (n: XNode | undefined, src: string): TmcNameValue[] =>
  n ? kids(n, 'Property').map(p => ({ name: textOf(kid(p, 'Name'), src) ?? '', value: textOf(kid(p, 'Value'), src) })).filter(p => p.name) : [];

const SCALARS = ['Value', 'String', 'Bool', 'EnumText', 'DateTime'];

/** Stored default as text: a scalar, or `{ a := 1, b := 2 }` for SubItems. */
function defaultOf(n: XNode | undefined, src: string): string | undefined {
  if (!n) return undefined;
  for (const e of SCALARS) {
    const t = textOf(kid(n, e), src);
    if (t !== undefined) return t;
  }
  const items = kids(n, 'SubItem').map(s => `${textOf(kid(s, 'Name'), src) ?? '?'} := ${defaultOf(s, src) ?? '?'}`);
  return items.length ? `{ ${items.join(', ')} }` : undefined;
}

export function parseTmc(xml: string): TmcFile {
  const src = xml.replace(/^﻿/, '');
  const root = parseXml(src).children[0];
  if (root?.name !== 'TcModuleClass') throw new NotTmcError(`Not a TwinCAT module class file (root element ${root ? `<${root.name}>` : 'missing'})`);

  // first pass: the data types by GUID and name, so references resolve independently of the order in the file
  const typeNodes = (kid(root, 'DataTypes')?.children ?? []).filter(d => d.name === 'DataType' && textOf(kid(d, 'Name'), src));
  const byGuid = new Map<string, number>(), byKey = new Map<string, number>();
  typeNodes.forEach((d, i) => {
    const name = kid(d, 'Name')!;
    if (name.attrs.GUID) byGuid.set(name.attrs.GUID.toUpperCase(), i);
    for (const k of [keyOf(name, src), textOf(name, src)!]) if (!byKey.has(k.toUpperCase())) byKey.set(k.toUpperCase(), i);
  });
  /** `n`: a Type / BaseType / ExtendsType element. */
  const refOf = (n: XNode | undefined): number | undefined => {
    if (!n) return undefined;
    const key = keyOf(n, src).toUpperCase();
    const dot = key.lastIndexOf('.');
    return byGuid.get((n.attrs.GUID ?? '').toUpperCase()) ?? byKey.get(key) ?? (dot > 0 ? byKey.get(key.slice(dot + 1)) : undefined);
  };
  const varOf = (n: XNode, typeElement: string): TmcVar => ({
    name: textOf(kid(n, 'Name'), src) ?? '',
    type: typeOf(n, typeElement, src),
    ref: refOf(kid(n, typeElement)),
    bitSize: intOf(kid(n, 'BitSize'), src),
    bitOffs: intOf(kid(n, 'BitOffs'), src),
    comment: textOf(kid(n, 'Comment'), src),
    default: defaultOf(kid(n, 'Default'), src),
    properties: nameValues(kid(n, 'Properties'), src),
  });

  const types = typeNodes.map((d): TmcType => {
    const name = kid(d, 'Name')!;
    const members = d.children.filter(c => (c.name === 'SubItem' || c.name === 'PropertyItem') && textOf(kid(c, 'Name'), src)).map(c => varOf(c, 'Type'));
    const enumValues = kids(d, 'EnumInfo').map(e => ({ text: textOf(kid(e, 'Text'), src) ?? '', value: textOf(kid(e, 'Enum'), src), comment: textOf(kid(e, 'Comment'), src) }));
    const baseNode = kid(d, 'BaseType');
    const isArray = kids(d, 'ArrayInfo').length > 0;
    const hasBody = members.length > 0 || kids(d, 'Method').length > 0 || !!kid(d, 'ExtendsType');
    const kind: TmcTypeKind = enumValues.length ? 'enum' : isArray ? 'array' : hasBody ? 'struct' : baseNode ? 'alias' : 'other';
    return {
      name: textOf(name, src)!, namespace: name.attrs.Namespace, guid: name.attrs.GUID, kind,
      bitSize: intOf(kid(d, 'BitSize'), src), comment: textOf(kid(d, 'Comment'), src),
      base: baseNode ? typeOf(d, 'BaseType', src) : undefined, baseRef: refOf(baseNode),
      extends: textOf(kid(d, 'ExtendsType'), src), extendsRef: refOf(kid(d, 'ExtendsType')),
      members, enumValues,
      methods: kids(d, 'Method').map(m => {
        const params = kids(m, 'Parameter').map(p => `${textOf(kid(p, 'Name'), src) ?? ''} : ${typeOf(p, 'Type', src)}`);
        const ret = textOf(kid(m, 'ReturnType'), src);
        return `${textOf(kid(m, 'Name'), src) ?? ''}(${params.join(', ')})${ret ? ` : ${ret}` : ''}`;
      }),
      properties: nameValues(kid(d, 'Properties'), src),
    };
  });

  const modules = kids(kid(root, 'Modules') ?? root, 'Module').map((m): TmcModule => {
    const clsid = kid(m, 'CLSID');
    return {
      name: textOf(kid(m, 'Name'), src) ?? '',
      guid: m.attrs.GUID,
      group: m.attrs.Group,
      clsid: textOf(clsid, src),
      classFactory: clsid?.attrs.ClassFactory,
      initSequence: textOf(kid(m, 'InitSequence'), src),
      contexts: kids(kid(m, 'Contexts') ?? m, 'Context').map(c => ({
        id: intOf(kid(c, 'Id'), src), name: textOf(kid(c, 'Name'), src), priority: intOf(kid(c, 'Priority'), src), cycleTimeNs: intOf(kid(c, 'CycleTime'), src),
      })),
      interfaces: kids(kid(m, 'Interfaces') ?? m, 'Interface').map(i => textOf(kid(i, 'Type'), src) ?? '').filter(Boolean),
      licenses: kids(kid(m, 'Licenses') ?? m, 'License').map(l => textOf(kid(l, 'LicenseId'), src) ?? '').filter(Boolean),
      parameters: kids(kid(m, 'Parameters') ?? m, 'Parameter').map(p => ({
        name: textOf(kid(p, 'Name'), src) ?? '', type: typeOf(p, 'BaseType', src), ref: refOf(kid(p, 'BaseType')), bitSize: intOf(kid(p, 'BitSize'), src),
        ptcid: textOf(kid(p, 'PTCID'), src), readOnly: p.attrs.ReadOnly === 'true', comment: textOf(kid(p, 'Comment'), src),
      })),
      areas: kids(kid(m, 'DataAreas') ?? m, 'DataArea').map(a => {
        const no = kid(a, 'AreaNo');
        return {
          no: intOf(no, src), areaType: no?.attrs.AreaType, name: textOf(kid(a, 'Name'), src) ?? '',
          contextId: intOf(kid(a, 'ContextId'), src), byteSize: intOf(kid(a, 'ByteSize'), src),
          symbols: kids(a, 'Symbol').filter(s => textOf(kid(s, 'Name'), src)).map(s => varOf(s, 'BaseType')),
        };
      }),
      properties: nameValues(kid(m, 'Properties'), src),
    };
  });

  return { vendor: textOf(kid(kid(root, 'Vendor') ?? root, 'Name'), src), modules, types };
}
