// IO-Link structure of a TwinCAT system project: every IO-Link master box (EL6224, EP6224 …) with its ports, the
// device configured on each port (from the IODD data TwinCAT keeps in the box's <Xml><Port>) and the port's
// process data with the linked variables.
//
// A master's port is an 'IO-Link Channel' slot of the box: its module names the port, its PdoIndex points to the
// 'IO-Link PortN' PDO. The <Port> elements under <Xml> are the devices of the ports, in port order.
//
// Also moves an inline box into its own .xti ("independent project file"), the way TwinCAT stores it: the parent
// keeps <Box File="<name>.xti" Id=".."> with the PortABoxInfo, the new file holds the box with its images
// (renumbered from 1000) and the data types it uses. Links stay where they are, their owner names are absolute.

import * as path from 'path';
import { parseXml, XNode, child, escapeAttr } from '../xml';
import { Doc, FileReader, HwLink, LinkFile, hasAncestor, linkFileSet, shortName, snapshotOf, text, toFileName, walk } from './iotree';

export interface IoLinkDevice {
  vendor?: string;
  name?: string;
  family?: string;
  text?: string;
  /** IODD file name. */
  iodd?: string;
  vendorId?: number;
  deviceId?: number;
}

export interface IoLinkEntry { name: string; type: string; bitLen?: number; /** Linked values, short names (Plc^MAIN.x). */ linked: string[] }

export interface IoLinkPort {
  number: number;
  /** Name of the port's module, e.g. 'Valve terminal 1'; undefined for a port without module. */
  name?: string;
  /** Module type, e.g. 'IO-Link Slave', 'Digital Input'. */
  mode?: string;
  device?: IoLinkDevice;
  /** Name of the port's PDO, e.g. 'IO-Link Port1'. */
  pdo?: string;
  entries: IoLinkEntry[];
}

export interface IoLinkMaster {
  name: string;
  /** Full item path, TIID^device^…^box. */
  path: string;
  /** EtherCAT type, e.g. 'EP6224-3022 (IO Link Master Class B)'. */
  type?: string;
  /** File the box is stored in (absolute). */
  file: string;
  /** Offset of the <Box> in that file. */
  offset: number;
  /** The box is stored in a file of its own. */
  independent: boolean;
  ports: IoLinkPort[];
}

export interface IoLinkStructure { masters: IoLinkMaster[]; warnings: string[] }

const isChannelSlot = (s: XNode) => s.name === 'Slot' && /IO-?Link/i.test(s.attrs.Name ?? '');

function isMaster(box: XNode): boolean {
  const ec = child(box, 'EtherCAT');
  if (!ec) return false;
  if (/IO-?Link Master/i.test(ec.attrs.Type ?? '')) return true;
  return ec.children.some(isChannelSlot) || ec.children.some(p => p.name === 'Pdo' && /^IO-?Link Port\s*\d+/i.test(p.attrs.Name ?? ''));
}

/** TwinCAT writes numbers as '#x1600', '0x1600' or decimal. */
const num = (s: string | undefined) => {
  if (!s) return undefined;
  const t = s.trim();
  const v = /^(?:#x|0x)/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, 10);
  return Number.isNaN(v) ? undefined : v;
};

function device(doc: Doc, port: XNode | undefined): IoLinkDevice | undefined {
  if (!port) return undefined;
  const t = (n: string) => text(doc, child(port, n)) || undefined;
  const d: IoLinkDevice = { vendor: t('VendorName'), name: t('DeviceName'), family: t('DeviceFamilyName'), text: t('DeviceText'), iodd: t('FileName') };
  // DirectParameter starts with the device id and the vendor id (4 bytes each, big endian).
  const direct = t('DirectParameter');
  if (direct && /^[0-9a-f]{16}/i.test(direct)) {
    d.deviceId = parseInt(direct.slice(0, 8), 16);
    d.vendorId = parseInt(direct.slice(8, 16), 16);
  }
  return d.name || d.vendor ? d : undefined;
}

/** Path of a box (not stored in its own file) from the item path of its file. */
function boxPath(f: LinkFile, box: XNode): string | undefined {
  const names: string[] = [];
  for (let a: XNode | undefined = box; a && a.parent && a.parent.name !== 'TcSmItem'; a = a.parent) {
    if (a.name !== 'Box') continue;
    const n = text(f.doc, child(a, 'Name'));
    if (!n) return undefined;
    names.unshift(n);
  }
  return names.length ? `${f.itemPath}^${names.join('^')}` : f.itemPath;
}

function masterOf(f: LinkFile, box: XNode, linked: Map<string, string[]>): IoLinkMaster | undefined {
  const doc = f.doc;
  const independent = box.parent?.name === 'TcSmItem';
  const full = independent ? f.itemPath : boxPath(f, box);
  if (!full) return undefined;
  const ec = child(box, 'EtherCAT')!;
  const pdos = new Map<number, XNode>();
  for (const p of ec.children) if (p.name === 'Pdo') { const i = num(p.attrs.Index); if (i !== undefined) pdos.set(i, p); }
  const devices = (child(box, 'Xml')?.children ?? []).filter(c => c.name === 'Port');

  const ports: IoLinkPort[] = ec.children.filter(isChannelSlot).map((slot, i) => {
    const module = child(slot, 'Module');
    const name = module ? text(doc, child(module, 'Name')) || undefined : undefined;
    const pdo = module?.children.filter(c => c.name === 'PdoIndex').map(c => pdos.get(num(text(doc, c)) ?? -1)).find(p => p);
    const pdoName = pdo?.attrs.Name;
    const number = num(/Port\s*(\d+)/i.exec(pdoName ?? '')?.[1]) ?? i + 1;
    const entries: IoLinkEntry[] = [];
    for (const e of pdo?.children ?? []) {
      if (e.name !== 'Entry' || !e.attrs.Name) continue;
      const io = [full, name, pdoName, e.attrs.Name].filter(Boolean).join('^');
      entries.push({ name: e.attrs.Name, type: text(doc, child(e, 'Type')), bitLen: num(e.attrs.BitLen), linked: linked.get(io) ?? [] });
    }
    return { number, name, mode: module?.attrs.Type, device: module ? device(doc, devices[i]) : undefined, pdo: pdoName, entries };
  });
  return { name: full.slice(full.lastIndexOf('^') + 1), path: full, type: ec.attrs.Type, file: f.path, offset: box.start, independent, ports };
}

/** Linked values by IO side (full path). */
function linkIndex(links: HwLink[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (io: string, other: string) => m.set(io, [...(m.get(io) ?? []), shortName(other)]);
  for (const l of links) {
    if (l.left.startsWith('TIID^')) add(l.left, l.right);
    if (l.right.startsWith('TIID^')) add(l.right, l.left);
  }
  return m;
}

/** Every IO-Link master of a system project, in the order of the IO tree. */
export async function readIoLinkStructure(tsproj: string, read: FileReader): Promise<IoLinkStructure> {
  const warnings: string[] = [];
  const files = await linkFileSet(tsproj, read, warnings);
  const linked = linkIndex(snapshotOf(tsproj, files, warnings).links);
  const masters: IoLinkMaster[] = [];
  for (const f of files) {
    if (f.category !== 'IO' || !f.doc.root) continue;
    for (const box of walk(f.doc.root)) {
      if (box.name !== 'Box' || box.attrs.File !== undefined || hasAncestor(box, 'Mappings') || !isMaster(box)) continue;
      const m = masterOf(f, box, linked);
      if (m) masters.push(m);
    }
  }
  return { masters, warnings };
}

// ---------------------------------------------------------------------------------------------
// Independent project file

export interface Extraction {
  /** The parent file with the box replaced by a reference. */
  parent: string;
  /** Absolute path of the new .xti. */
  file: string;
  content: string;
}

/** Moves the inline box at `offset` of `parentFile` (an .xti) into its own .xti next to it, as TwinCAT does. */
export function extractBox(parentSrc: string, parentFile: string, offset: number): Extraction {
  const bom = parentSrc.startsWith('﻿') ? '﻿' : '';
  const src = bom ? parentSrc.slice(1) : parentSrc;
  const root = parseXml(src).children.find(c => !c.name.startsWith('?'));
  if (!root || root.name !== 'TcSmItem') throw new Error(`${path.basename(parentFile)} is not a TwinCAT item file (.xti).`);
  const box = [...walk(root)].find(n => n.name === 'Box' && n.start === offset);
  if (!box) throw new Error(`No box at offset ${offset} of ${path.basename(parentFile)}; reload and try again.`);
  if (box.attrs.File !== undefined || box.parent === root) throw new Error('The box is already stored in its own file.');
  if (box.attrs.BoxType !== '9099') throw new Error(`Only EtherCAT terminals and boxes can be saved as an independent file here (BoxType ${box.attrs.BoxType ?? '?'}).`);
  const doc: Doc = { src, root };
  const nameNode = child(box, 'Name');
  const name = text(doc, nameNode);
  if (!nameNode || !name || name === '__FILENAME__') throw new Error('The box has no name.');

  // Folder: one per file and per inline box on the way (see iotree addFile).
  const inline: string[] = [];
  for (let a = box.parent; a && a !== root; a = a.parent) if (a.name === 'Box') inline.unshift(text(doc, child(a, 'Name')));
  const dir = path.join(path.dirname(parentFile), path.basename(parentFile, path.extname(parentFile)), ...inline.map(toFileName));
  const fileName = toFileName(name) + '.xti';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';

  // The box text, moved to depth 1, named __FILENAME__, without the PortABoxInfo that stays in the parent.
  const lineStart = src.lastIndexOf('\n', box.start - 1) + 1;
  const indent = /^[\t ]*/.exec(src.slice(lineStart, box.start))![0];
  const ec = child(box, 'EtherCAT');
  const portInfo = ec?.attrs.PortABoxInfo;
  const cuts: { start: number; end: number; text: string }[] = [{ start: nameNode.innerStart, end: nameNode.innerEnd, text: '__FILENAME__' }];
  if (ec && portInfo !== undefined) {
    const tag = src.slice(ec.start, ec.innerStart === ec.end ? ec.end : ec.innerStart);
    const m = /\s+PortABoxInfo="[^"]*"/.exec(tag)!;
    cuts.push({ start: ec.start + m.index, end: ec.start + m.index + m[0].length, text: '' });
  }
  let body = src.slice(box.start, box.end);
  for (const c of cuts.sort((a, b) => b.start - a.start)) body = body.slice(0, c.start - box.start) + c.text + body.slice(c.end - box.start);
  const strip = indent.length > 1 ? indent.slice(1) : '';
  if (strip) body = body.split('\n').map((l, i) => (i > 0 && l.startsWith(strip) ? l.slice(strip.length) : l)).join('\n');

  // Images: the ones the box uses, renumbered from 1000 in order of use.
  const images = new Map<string, XNode>();
  for (const n of child(root, 'ImageDatas')?.children ?? []) if (n.name === 'ImageData' && n.attrs.Id) images.set(n.attrs.Id, n);
  const renumber = new Map<string, string>();
  for (const m of body.matchAll(/<ImageId>(\d+)<\/ImageId>|\sImageId="(\d+)"/g)) {
    const id = m[1] ?? m[2];
    if (images.has(id) && !renumber.has(id)) renumber.set(id, String(1000 + renumber.size));
  }
  body = body.replace(/(<ImageId>)(\d+)(<\/ImageId>)|(\sImageId=")(\d+)(")/g, (all, a, id1, b, c, id2, d) => {
    const to = renumber.get(id1 ?? id2);
    return !to ? all : id1 !== undefined ? a + to + b : c + to + d;
  });
  const imageLines = [...renumber].map(([from, to]) => '\t\t' + src.slice(images.get(from)!.start, images.get(from)!.end).replace(/^<ImageData Id="\d+"/, `<ImageData Id="${to}"`));

  // Data types: the ones the box refers to by GUID, and the ones those refer to.
  const types = new Map<string, XNode>();
  for (const n of child(root, 'DataTypes')?.children ?? []) {
    const g = n.name === 'DataType' ? child(n, 'Name')?.attrs.GUID : undefined;
    if (g) types.set(g.toUpperCase(), n);
  }
  const used: XNode[] = [];
  const pending = [body];
  while (pending.length) {
    for (const m of pending.pop()!.matchAll(/GUID="(\{[^"]+\})"/g)) {
      const t = types.get(m[1].toUpperCase());
      if (!t || used.includes(t)) continue;
      used.push(t);
      pending.push(src.slice(t.start, t.end));
    }
  }
  used.sort((a, b) => a.start - b.start);

  const rootTag = src.slice(root.start, root.innerStart)
    .replace(/\sClassName="[^"]*"/, ' ClassName="CFlbTermDef"').replace(/\sSubType="[^"]*"/, ` SubType="${box.attrs.BoxType}"`);
  const out = ['<?xml version="1.0"?>', rootTag];
  if (used.length) out.push('\t<DataTypes>', ...used.map(t => '\t\t' + src.slice(t.start, t.end)), '\t</DataTypes>');
  if (imageLines.length) out.push('\t<ImageDatas>', ...imageLines, '\t</ImageDatas>');
  out.push('\t' + body, '</TcSmItem>');
  const content = bom + out.join(eol).replace(/\r?\n/g, eol) + eol;

  const stub = portInfo !== undefined
    ? `<Box File="${escapeAttr(fileName)}" Id="${escapeAttr(box.attrs.Id ?? '')}">${eol}${indent}\t<EtherCAT PortABoxInfo="${escapeAttr(portInfo)}"/>${eol}${indent}</Box>`
    : `<Box File="${escapeAttr(fileName)}" Id="${escapeAttr(box.attrs.Id ?? '')}"/>`;
  return { parent: bom + src.slice(0, box.start) + stub + src.slice(box.end), file: path.join(dir, fileName), content };
}
