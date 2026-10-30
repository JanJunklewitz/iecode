// TwinCAT visualizations (.TcVIS): the CODESYS XmlArchive inside <Visu> as a model of elements, a plain-text
// summary (for diffs and the simplified view) and in-place edits of single values.
//
// Element properties are stored as a list of { Id, Value } pairs, where Id is the CRC-32 of the property's path
// in the element function block (e.g. crc32("m_StaticPosition.iX")). Parameters of frames (references to other
// visualizations) and other structured inputs carry their own name tree with the same ids (TypeNodeIdLong).
// Like the ST view, edits are splices on the original text: everything we don't touch stays byte-identical.

import { XNode, parseXml } from '../xml';

// ---------- property names ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of Buffer.from(s, 'utf8')) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Property paths of the standard elements, as hashed into member ids. */
const PROPERTY_PATHS = [
  'm_StaticPosition.iX', 'm_StaticPosition.iY', 'm_StaticPosition.iWidth', 'm_StaticPosition.iHeight', 'm_StaticPosition.m_iAngle',
  'm_StaticCenter.iX', 'm_StaticCenter.iY', 'm_StaticType',
  'm_StaticColors.NormalColors.dwFillColor', 'm_StaticColors.NormalColors.dwFrameColor',
  'm_StaticColors.AlarmColors.dwFillColor', 'm_StaticColors.AlarmColors.dwFrameColor',
  'm_StaticColors.dwNormalColor', 'm_StaticColors.dwAlarmColor', 'm_dwTransparentColor',
  'm_StaticElementLook.iLineWidth', 'm_StaticElementLook.dwFillFlags', 'm_StaticElementLook.dwFrameFlags',
  'm_StaticTexts.pstText', 'm_StaticTexts.pstToolTip', '_pstTextId', '_pstTooltipId',
  'm_pTextChanges..pVarText', 'm_pTextChanges..pVarTooltip',
  'm_pStaticTextProperties..Font', 'm_pStaticTextProperties..Font.Name', 'm_pStaticTextProperties..Font.Height',
  'm_pStaticTextProperties..Font.Color', 'm_pStaticTextProperties..Font.CharSet',
  'm_pStaticTextProperties..HorizontalAlignment', 'm_pStaticTextProperties..VerticalAlignment', 'm_pStaticTextProperties..TextFlag',
  'm_TextProperties.TextPropSource', 'm_pVariable..pVariable', 'm_pVariable..pVarNumber', 'pVariable',
  'm_pButtonStateVariable..DigitalVar', 'm_pDynamicText..stTextList', 'm_pDynamicImagePool..m_stImagePool',
  'm_References', 'm_ShadowType', 'm_nIsotropicType', 'm_nShowFrameType', 'm_iFrame', 'm_bDrawFrame', 'm_bShowFrame',
  'm_bClip', 'm_bClipGroupBox', 'm_bTransparent', 'm_bDeactivateBackgroundDrawing', 'm_xUseNewLook',
  'm_stStaticID', 'm_BitmapInfo.m_stStaticID', 'm_iIndexTabWidth', 'Tabs',
  'm_SubRange.bSubRange', 'm_SubRange.iStartIndex', 'm_SubRange.iEndIndex', 'm_SubRange.bShowOnlyExistingTexts',
  'm_List.m_iRowHeight', 'm_List.m_iScrollbarSize', 'm_List.m_iVisibleRows', 'm_List.m_iImageHeight', 'm_List.m_iImageWidth', 'm_List.m_iImageOffset',
  'm_SelectionConfiguration.dwSelectionColor', 'm_SelectionConfiguration.dwSelectionFontColor',
  'm_DataArrayType', 'm_iFirstRowIndex', 'm_TextBufferInformation.pSize',
  'Columns', 'DataArray', 'FirstRowIndex', 'RowHeaderWidth', 'RowHeight', 'ScrollbarSize', 'ShowColumnHeader', 'ShowRowHeader',
];

/** Readable names of the properties above (the rest show their path). */
const LABELS: Record<string, string> = {
  'm_StaticPosition.iX': 'X', 'm_StaticPosition.iY': 'Y', 'm_StaticPosition.iWidth': 'Width', 'm_StaticPosition.iHeight': 'Height',
  'm_StaticPosition.m_iAngle': 'Angle', 'm_StaticCenter.iX': 'Center X', 'm_StaticCenter.iY': 'Center Y', 'm_StaticType': 'Shape',
  'm_StaticColors.NormalColors.dwFillColor': 'Fill color', 'm_StaticColors.NormalColors.dwFrameColor': 'Frame color',
  'm_StaticColors.AlarmColors.dwFillColor': 'Alarm fill color', 'm_StaticColors.AlarmColors.dwFrameColor': 'Alarm frame color',
  'm_StaticElementLook.iLineWidth': 'Line width', 'm_StaticElementLook.dwFillFlags': 'Fill style', 'm_StaticElementLook.dwFrameFlags': 'Line style',
  'm_StaticTexts.pstText': 'Text', 'm_StaticTexts.pstToolTip': 'Tooltip', '_pstTextId': 'Text id', '_pstTooltipId': 'Tooltip id',
  'm_pTextChanges..pVarText': 'Text variable', 'm_pTextChanges..pVarTooltip': 'Tooltip variable',
  'm_pStaticTextProperties..Font': 'Font', 'm_pStaticTextProperties..Font.Name': 'Font name', 'm_pStaticTextProperties..Font.Height': 'Font size',
  'm_pStaticTextProperties..Font.Color': 'Font color', 'm_pStaticTextProperties..HorizontalAlignment': 'Horizontal alignment',
  'm_pStaticTextProperties..VerticalAlignment': 'Vertical alignment', 'm_pStaticTextProperties..TextFlag': 'Text flags',
  'm_pVariable..pVariable': 'Variable', 'm_pVariable..pVarNumber': 'Variable', 'pVariable': 'Variable',
  'm_pButtonStateVariable..DigitalVar': 'State variable', 'm_pDynamicText..stTextList': 'Text list',
  'm_nIsotropicType': 'Scaling', 'm_stStaticID': 'Image', 'm_BitmapInfo.m_stStaticID': 'Image', 'DataArray': 'Data array',
};

const NAMES = new Map<number, string>(PROPERTY_PATHS.map(p => [crc32(p), p]));
export const propertyId = (path: string) => crc32(path);
const P = (path: string) => crc32(path);

// ---------- model ----------

export interface Color { rgb: string; style?: string }          // '#rrggbb'; style: named style color (not editable here)
export interface Rect { x: number; y: number; w: number; h: number; angle: number }

export interface Member {
  id: number;
  path?: string;          // property path, if known
  label: string;          // readable name (label, path, frame parameter or #id)
  value: string;          // display value
  raw?: string;           // raw text of a scalar <v>, if editable
  kind: 'number' | 'string' | 'bool' | 'enum' | 'color' | 'complex';
  expr: boolean;          // the value is an IEC expression (variable, parameter)
}

export interface Action { event: string; kind: string; fields: { name: string; value: string; raw: string }[] }

export interface VisuElement {
  guid: string;
  name: string;           // VisualElementName, e.g. "Rectangle"
  type: string;           // element FB, e.g. VisuFbElemSimple
  kind: string;           // readable kind, e.g. Rectangle, Textfield, Frame
  identifier: string;     // GenElemInst_<n>
  rect: Rect;
  shape: 'rect' | 'ellipse' | 'roundrect' | 'line';
  fill?: Color;
  frame?: Color;
  noFill: boolean;
  noFrame: boolean;
  lineWidth: number;
  text: string;
  tooltip: string;
  textVar: string;
  tooltipVar: string;
  font: { name: string; size: number; color: string };
  align: { h: string; v: string };
  refs: string[];         // frame: referenced visualizations
  params: Member[];       // frame: parameter assignments
  variables: Member[];    // all members whose value is an expression
  actions: Action[];
  columns: string[];      // table: column expressions
  members: Member[];
  children: VisuElement[];
}

export interface Visu {
  name: string;
  guid: string;
  width: number;
  height: number;
  background: string;
  stored: { size: boolean; background: boolean };   // stored in the file, so editable (else defaults: set them once in TwinCAT)
  declaration: string;
  elements: VisuElement[];
}

// ---------- helpers on the XML tree ----------

const ch = (n: XNode | undefined, name: string) => n?.children.find(c => c.attrs.n === name);
const inner = (src: string, n: XNode) => src.slice(n.innerStart, n.innerEnd);
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(x?)([0-9a-f]+);/gi, (_, x, n) => String.fromCodePoint(parseInt(n, x ? 16 : 10))).replace(/&amp;/g, '&');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Value of an archive scalar: "text" → text, 12U / 3L / 1UL → number text, true/false, GUIDs as they are. */
function scalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unescapeXml(t.slice(1, -1));
  const m = /^(-?\d+)(?:U|L|UL)?$/.exec(t);
  return m ? m[1] : unescapeXml(t);
}
const vText = (src: string, n: XNode | undefined) => (n && n.name === 'v' ? scalar(inner(src, n)) : '');

/** ARGB (signed or unsigned) → #rrggbb; the alpha byte isn't used for opacity by the archive's colors. */
export function argbToHex(v: number): string {
  return '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

function color(src: string, value: XNode | undefined): Color | undefined {
  if (!value) return undefined;
  if (value.name === 'v') {
    const n = Number(scalar(inner(src, value)));
    return Number.isFinite(n) ? { rgb: argbToHex(n) } : undefined;
  }
  // NamedStyleColor, or an ArrayList with one
  const o = value.attrs.t === 'NamedStyleColor' ? value : value.children.find(c => c.name === 'o');
  const c = ch(o, 'Color');
  if (!c) return undefined;
  return { rgb: argbToHex(Number(vText(src, c))), style: vText(src, ch(o, 'CanonicalName')) || undefined };
}

const KINDS: Record<string, string> = {
  VisuFbElemSimple: 'Rectangle', VisuFbElemTextfield: 'Textfield', VisuFbLabel: 'Label', VisuFbFrame: 'Frame',
  VisuFbElemButton: 'Button', VisuFbGroup: 'Group', VisuFbGroupBox: 'Group box', VisuFbTabControl: 'Tab control',
  VisuFbElemTable: 'Table', VisuFbElemImage: 'Image', VisuFbCheckbox: 'Checkbox', VisuFbComboBoxInteger: 'Combo box',
  VisuFbComboBoxArray: 'Combo box', VisuFbElemLine: 'Line', VisuFbElemPolygon: 'Polygon', VisuFbElemPie: 'Pie',
  VisuFbRadioButton: 'Radio button', VisuFbElemMeter: 'Meter', VisuFbElemBarDisplay: 'Bar display', VisuFbElemSlider: 'Slider',
  VisuFbElemScrollbar: 'Scrollbar', VisuFbElemSpinControl: 'Spin control', VisuFbElemTextEditor: 'Text editor',
  VisuFbElemTrace: 'Trace', VisuFbElemLamp: 'Lamp', VisuFbElemSwitch: 'Switch', VisuFbElemPotentiometer: 'Potentiometer',
  VisuFbElemImageSwitcher: 'Image switcher',
};

const ACTION_KINDS: Record<string, string> = {
  InputBoxInputAction: 'Write variable', ToggleVarInputAction: 'Toggle variable', TapVarInputAction: 'Tap variable',
  FrameSelectionChangeInputAction: 'Change shown frame', ChangeShownVisuInputAction: 'Change shown visualization',
  ExecuteSTInputAction: 'Execute ST code', OpenDialogInputAction: 'Open dialog', CloseDialogInputAction: 'Close dialog',
  ExecuteCommandInputAction: 'Execute command', ChangeLanguageInputAction: 'Change language',
};

/** TypeNodeIdLong → dotted name of the type nodes below a structured value (frame parameters, table columns, …). */
function typeNodeNames(src: string, node: XNode, prefix: string, out: Map<number, string>) {
  const idNode = ch(node, 'TypeNodeIdLong');
  const nameNode = ch(node, 'TypeNodeName');
  let path = prefix;
  if (idNode && nameNode) {
    const nm = vText(src, nameNode);
    const ref = vText(src, ch(node, 'VisNodeRefs33'));
    // a referenced visualization starts a new name: "VI_Motor.fbMotor"
    path = ref ? ref : nm ? (prefix && !nm.startsWith('[') ? `${prefix}.${nm}` : prefix + nm) : prefix;
    out.set(Number(vText(src, idNode)), path || nm);
  }
  for (const c of node.children) {
    if (c.attrs.n === 'TypeNodeType' || c.attrs.n === 'TypeNodeAttributes') continue;
    typeNodeNames(src, c, path, out);
  }
}

function membersOf(src: string, elem: XNode): { list: Member[]; byId: Map<number, XNode> } {
  const list: Member[] = [];
  const byId = new Map<number, XNode>();
  const coll = ch(ch(elem, 'VisualElemMemberList'), 'VisualElemMemberList');
  if (!coll) return { list, byId };
  // names of structured members' children (frame parameters are separate members with these ids)
  const typeNames = new Map<number, string>();
  for (const o of coll.children) {
    const v = ch(o, 'Value');
    if (v && v.name === 'o' && /TypeNode|VisualizationNode/.test(v.attrs.t ?? '')) typeNodeNames(src, v, '', typeNames);
  }
  for (const o of coll.children) {
    const idNode = ch(o, 'Id');
    const v = ch(o, 'Value');
    if (!idNode || !v) continue;
    const id = Number(scalar(inner(src, idNode)));
    byId.set(id, v);
    const path = NAMES.get(id);
    const param = path ? undefined : typeNames.get(id);
    const label = path ? LABELS[path] ?? path : param ?? `#${id}`;
    let m: Member;
    if (v.name === 'v') {
      const raw = inner(src, v);
      const value = scalar(raw);
      const t = raw.trim();
      const kind: Member['kind'] = /Color$/i.test(path ?? '') ? 'color'
        : t.startsWith('"') ? 'string' : t === 'true' || t === 'false' ? 'bool' : /^-?\d/.test(t) ? 'number' : 'enum';
      const expr = kind === 'string' && (!!param || /variable|DataArray/i.test(LABELS[path ?? ''] ?? path ?? '')
        || (!path && looksLikeExpression(value)));
      m = { id, path, label, value: kind === 'color' ? argbToHex(Number(value)) : value, raw, kind, expr };
    } else {
      const c = color(src, v);
      if (c) m = { id, path, label, value: c.style ? `${c.rgb} (${c.style})` : c.rgb, kind: 'color', expr: false };
      else m = { id, path, label, value: summarizeComplex(src, v), kind: 'complex', expr: false };
    }
    list.push(m);
  }
  return { list, byId };
}

const looksLikeExpression = (s: string) => /^[A-Za-z_][\w]*(\s*(\.|\[[^\]]*\])\s*[A-Za-z_\w]*)*(\^)?$/.test(s.trim()) && /[.\[]/.test(s);

function summarizeComplex(src: string, v: XNode): string {
  const t = v.attrs.t ?? v.attrs.cet ?? v.name;
  if (t === 'NamedStyleFont' || v.attrs.cet === 'NamedStyleFont') {
    const o = t === 'NamedStyleFont' ? v : v.children.find(c => c.name === 'o');
    return `${vText(src, ch(o, 'FontName'))} ${vText(src, ch(o, 'FontSize'))} (${vText(src, ch(o, 'CanonicalName'))})`;
  }
  if (t === 'DataVariableInformation') return vText(src, ch(v, 'DataArrayType'));
  return `(${t})`;
}

function actionsOf(src: string, elem: XNode): Action[] {
  const d = ch(elem, 'VisualElementInputActions');
  if (!d) return [];
  const out: Action[] = [];
  let event = '';
  for (const c of d.children) {
    if (c.name === 'v') { event = vText(src, c); continue; }
    const kind = c.attrs.cet ?? '';
    for (const o of c.children.filter(x => x.name === 'o')) {
      const fields: Action['fields'] = [];
      const walk = (n: XNode, prefix: string) => {
        for (const f of n.children) {
          if (f.name === 'v' && f.attrs.n) {
            const raw = inner(src, f);
            if (raw.trim().startsWith('"')) fields.push({ name: prefix + f.attrs.n, value: scalar(raw), raw });
            else if (!f.attrs.t || /Type|Setting/.test(f.attrs.t)) fields.push({ name: prefix + f.attrs.n, value: scalar(raw), raw });
          } else if (f.name === 'o' && f.attrs.n) walk(f, `${prefix}${f.attrs.n}.`);
        }
      };
      walk(o, '');
      out.push({ event, kind: ACTION_KINDS[kind] ?? kind.replace(/InputAction$/, ''), fields });
    }
  }
  return out;
}

const num = (src: string, v: XNode | undefined, dflt = 0) => {
  if (!v || v.name !== 'v') return dflt;
  const n = Number(scalar(inner(src, v)));
  return Number.isFinite(n) ? n : dflt;
};
const str = (src: string, v: XNode | undefined) => (v && v.name === 'v' ? scalar(inner(src, v)) : '');

function elementOf(src: string, o: XNode): VisuElement {
  const { list, byId } = membersOf(src, o);
  const get = (path: string) => byId.get(P(path));
  const type = str(src, ch(o, 'VisualElementTypeName'));
  const staticType = str(src, get('m_StaticType'));
  const shape: VisuElement['shape'] = /CIRCLE|ELLIPSE/.test(staticType) ? 'ellipse' : /ROUND/.test(staticType) ? 'roundrect'
    : /LINE/.test(staticType) ? 'line' : 'rect';
  let kind = KINDS[type] ?? type.replace(/^VisuFb(Elem)?/, '');
  if (type === 'VisuFbElemSimple') kind = shape === 'ellipse' ? 'Ellipse' : shape === 'roundrect' ? 'Rounded rectangle' : shape === 'line' ? 'Line' : 'Rectangle';

  const fontNode = get('m_pStaticTextProperties..Font');
  let font = { name: str(src, get('m_pStaticTextProperties..Font.Name')) || 'Arial', size: num(src, get('m_pStaticTextProperties..Font.Height'), 12),
    color: get('m_pStaticTextProperties..Font.Color') ? argbToHex(num(src, get('m_pStaticTextProperties..Font.Color'))) : '#000000' };
  if (fontNode && fontNode.name !== 'v') {
    const f = fontNode.attrs.t === 'NamedStyleFont' ? fontNode : fontNode.children.find(c => c.name === 'o');
    if (f && ch(f, 'FontName')) {
      const nc = ch(f, 'NamedColor');
      font = { name: vText(src, ch(f, 'FontName')), size: Number(vText(src, ch(f, 'FontSize'))) || 12,
        color: argbToHex(Number(vText(src, ch(nc, 'Color') ?? ch(f, 'ExplicitColor')))) };
    }
  }

  const frameInfo = ch(o, 'VisualElementFrameInformation');
  const refs = [...(ch(frameInfo, 'ContainedVisualizations33')?.children ?? []), ...(ch(frameInfo, 'ContainedVisualizations')?.children ?? [])]
    .filter(c => c.name === 'v').map(c => vText(src, c)).filter(Boolean);

  const table = byId.get(P('m_DataArrayType'));
  const columns = (ch(table, 'ColumnNames')?.children ?? []).filter(c => c.name === 'v').map(c => vText(src, c));

  const lineFlags = str(src, get('m_StaticElementLook.dwFrameFlags'));
  const fillFlags = str(src, get('m_StaticElementLook.dwFillFlags'));
  const showFrame = str(src, get('m_nShowFrameType'));
  const params = list.filter(m => m.label !== `#${m.id}` && !m.path && m.kind !== 'complex');
  const isText = /Textfield|Label|Button/.test(kind);
  const children = (ch(o, 'Elements')?.children ?? []).filter(c => c.name === 'o').map(c => elementOf(src, c));

  return {
    guid: str(src, ch(o, 'VisualElementIdentification')).replace(/[{}]/g, ''),
    name: str(src, ch(o, 'VisualElementName')),
    type, kind,
    identifier: str(src, ch(o, 'VisualElementIdentifier')),
    rect: {
      x: num(src, get('m_StaticPosition.iX')), y: num(src, get('m_StaticPosition.iY')),
      w: num(src, get('m_StaticPosition.iWidth')), h: num(src, get('m_StaticPosition.iHeight')),
      angle: num(src, get('m_StaticPosition.m_iAngle')),
    },
    shape,
    fill: color(src, get('m_StaticColors.NormalColors.dwFillColor')),
    frame: color(src, get('m_StaticColors.NormalColors.dwFrameColor')),
    noFill: /HOLLOW|NULL/.test(fillFlags) || str(src, get('m_bTransparent')) === 'true' || /^(Label|Group|Frame)$/.test(kind)
      || (isText && !get('m_StaticElementLook.dwFillFlags') && !get('m_StaticColors.NormalColors.dwFillColor')),
    noFrame: /HOLLOW|NULL/.test(lineFlags) || showFrame === 'NO_FRAME' || /^(Label|Group)$/.test(kind) || (isText && str(src, get('m_bDrawFrame')) === 'false'),
    lineWidth: num(src, get('m_StaticElementLook.iLineWidth'), 1),
    text: str(src, get('m_StaticTexts.pstText')),
    tooltip: str(src, get('m_StaticTexts.pstToolTip')),
    textVar: str(src, get('m_pTextChanges..pVarText')),
    tooltipVar: str(src, get('m_pTextChanges..pVarTooltip')),
    font,
    align: { h: str(src, get('m_pStaticTextProperties..HorizontalAlignment')) || 'HCENTER', v: str(src, get('m_pStaticTextProperties..VerticalAlignment')) || 'VCENTER' },
    refs, params,
    variables: list.filter(m => m.expr && m.value.trim() !== ''),
    actions: actionsOf(src, o),
    columns,
    members: list,
    children,
  };
}

/** <Visu> and its VisualObject (elements, size, background). */
function visualObject(root: XNode): { visu: XNode; obj: XNode } {
  const top = root.children.find(c => c.name === 'TcPlcObject');
  const visu = top?.children.find(c => c.name === 'Visu');
  if (!visu) throw new Error('not a TwinCAT visualization (no <Visu>)');
  const obj = visu.children.find(c => c.name === 'XmlArchive')?.children.find(c => c.name === 'Data')?.children.find(c => c.attrs.t === 'VisualObject');
  if (!obj) throw new Error('visualization has no element data');
  return { visu, obj };
}
const sizeOf = (obj: XNode) => ch(ch(obj, 'VisuSizeManager'), 'Size')?.children.find(c => c.name === 'o');
const backgroundOf = (obj: XNode) => ch(ch(obj, 'VisualElemList'), 'BackgroundColor');

/** The visualization in a .TcVIS file (with or without BOM). */
export function parseVisu(xml: string): Visu {
  const src = xml.replace(/^﻿/, '');
  const { visu, obj } = visualObject(parseXml(src));
  const list = ch(ch(obj, 'VisualElemList'), 'VisualElementList');
  const elements = (list?.children ?? []).filter(c => c.name === 'o').map(o => elementOf(src, o));

  const size = sizeOf(obj);
  let width = num(src, ch(size, 'Width')), height = num(src, ch(size, 'Height'));
  const sizeStored = ch(size, 'Width')?.name === 'v' && ch(size, 'Height')?.name === 'v';
  if (!width || !height) {
    for (const e of elements) { width = Math.max(width, e.rect.x + e.rect.w); height = Math.max(height, e.rect.y + e.rect.h); }
  }
  const bg = backgroundOf(obj);
  const lines = ch(ch(obj, 'TextDocument'), 'TextLines')?.children.filter(c => c.name === 'o').map(o => vText(src, ch(o, 'Text'))) ?? [];
  return {
    name: visu.attrs.Name ?? '',
    guid: (visu.attrs.Id ?? '').replace(/[{}]/g, ''),
    width: width || 800, height: height || 600,
    background: bg ? argbToHex(num(src, bg)) : '#ffffff',
    stored: { size: sizeStored, background: bg?.name === 'v' },
    declaration: lines.join('\n'),
    elements,
  };
}

export const flatten = (els: VisuElement[]): VisuElement[] => els.flatMap(e => [e, ...flatten(e.children)]);

// ---------- text summary (simplified view, diffs) ----------

/** A YAML scalar: plain when that's unambiguous, else a JSON string (valid YAML too). */
const q = (s: string) => (/^[A-Za-z_][\w.\[\]^]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) ? s : JSON.stringify(s));

/** A scalar inside a [flow, list]: brackets and commas need quotes there. */
const qf = (s: string) => (/[[\]{},]/.test(s) ? JSON.stringify(s) : q(s));

/** Tab titles of a tab control: [title, visualization]. */
export function tabsOf(e: VisuElement): { title: string; visu: string }[] {
  return e.params.filter(m => /\.pstTabTitle$/.test(m.label))
    .map(m => ({ title: m.value, visu: m.label.replace(/(\[\d+\])?\.pstTabTitle$/, '') }));
}
/** Parameters worth showing: not the internal text / image ids and tab titles of tab controls. */
export const shownParams = (e: VisuElement) => e.params.filter(m => !/\.(sTextId|sImageId|pstTabTitle)$/.test(m.label));

/** A readable, stable YAML text of the visualization: one entry per element with what it shows and does. */
export function visuToText(v: Visu, opts: { all?: boolean } = {}): string {
  const out: string[] = [`# Visualization ${v.name} (${v.width} x ${v.height})`, `name: ${q(v.name)}`, `size: [${v.width}, ${v.height}]`];
  if (v.declaration.trim()) out.push('interface: |', ...v.declaration.split('\n').map(l => '  ' + l.replace(/\t/g, '    ').trimEnd()));
  out.push('elements:');
  v.elements.forEach(e => elementLines(e, '  ', out, opts));
  return out.join('\n') + '\n';
}

/** The summary of one element (with its children), as in visuToText. */
export function elementToText(e: VisuElement, opts: { all?: boolean } = {}): string {
  const out: string[] = [];
  elementLines(e, '', out, opts);
  return out.join('\n') + '\n';
}

function elementLines(e: VisuElement, indent: string, out: string[], opts: { all?: boolean }) {
  const el = (e: VisuElement, ind: string) => {
    const r = e.rect;
    out.push(`${ind}- ${e.kind.replace(/ (\w)/g, (_, c: string) => c.toUpperCase())}: ${q(e.name)}`);
    const p = ind + '  ';
    const kv = (k: string, val: string) => out.push(val ? `${p}${k}: ${val}` : `${p}${k}:`);
    kv('id', e.identifier);
    kv('at', `[${r.x}, ${r.y}]`);
    kv('size', `[${r.w}, ${r.h}]`);
    if (r.angle) kv('angle', String(r.angle));
    if (e.text) kv('text', q(e.text));
    if (e.textVar) kv('textVariable', q(e.textVar));
    if (e.tooltip) kv('tooltip', q(e.tooltip));
    if (e.tooltipVar) kv('tooltipVariable', q(e.tooltipVar));
    const tabs = tabsOf(e);
    if (tabs.length) { kv('tabs', ''); tabs.forEach(t => out.push(`${p}  - ${q(t.title)}: ${q(t.visu)}`)); }
    else if (e.refs.length) kv('shows', e.refs.length === 1 ? q(e.refs[0]) : `[${e.refs.map(qf).join(', ')}]`);
    const params = shownParams(e);
    if (params.length) { kv('parameters', ''); params.forEach(m => out.push(`${p}  ${q(m.label)}: ${q(m.value)}`)); }
    const vars = e.variables.filter(m => !e.params.includes(m) && m.path !== 'm_pTextChanges..pVarText' && m.path !== 'm_pTextChanges..pVarTooltip');
    if (vars.length) { kv('variables', ''); vars.forEach(m => out.push(`${p}  ${q(m.label)}: ${q(m.value)}`)); }
    if (e.columns.length) kv('columns', `[${e.columns.map(qf).join(', ')}]`);
    if (e.actions.length) {
      kv('inputs', '');
      for (const a of e.actions) {
        out.push(`${p}  - ${q(a.event)}: ${q(a.kind)}`);
        for (const f of a.fields) if (f.value !== '' && f.value !== 'false') out.push(`${p}    ${q(f.name)}: ${q(f.value)}`);
      }
    }
    if (opts.all) {
      kv('properties', '');
      for (const m of e.members) out.push(`${p}  ${q(m.label)}: ${q(m.value)}`);
    } else {
      if (e.fill && !e.noFill) kv('fill', q(e.fill.style ?? e.fill.rgb));
      if (e.frame && !e.noFrame) kv('frame', q(e.frame.style ?? e.frame.rgb));
    }
    if (e.children.length) { kv('elements', ''); e.children.forEach(c => el(c, p + '  ')); }
  };
  el(e, indent);
}

// ---------- edits ----------

/** One value to change: a member of an element, a field of one of its input actions, or a setting of the visualization. */
export type VisuEdit =
  | { element: string; member: number; value: string }
  | { element: string; action: number; field: string; value: string }
  | { visu: 'width' | 'height' | 'background'; value: string };

export class VisuEditError extends Error {}

function findElement(src: string, root: XNode, guid: string): XNode | undefined {
  const want = guid.replace(/[{}]/g, '').toLowerCase();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'v' && n.attrs.n === 'VisualElementIdentification' && inner(src, n).replace(/[{}]/g, '').toLowerCase() === want) return n.parent;
    for (const c of n.children) stack.push(c);
  }
  return undefined;
}

/** New raw text for a scalar, in the format of the old one (quotes, U/L suffix, color with the old alpha). */
function encodeScalar(oldRaw: string, value: string, isColor: boolean): string {
  const t = oldRaw.trim();
  if (t.startsWith('"')) {
    if (value.includes('"')) throw new VisuEditError('double quotes are not supported in texts here; edit them in TwinCAT');
    return '"' + escapeXml(value) + '"';
  }
  if (isColor) {
    const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    if (!m) throw new VisuEditError(`not a color: ${value}`);
    const old = Number(scalar(t)) >>> 0;
    const n = ((old & 0xff000000) >>> 0) + parseInt(m[1], 16);
    return /U$/.test(t) ? `${n >>> 0}U` : String(n | 0);
  }
  if (t === 'true' || t === 'false') {
    if (value !== 'true' && value !== 'false') throw new VisuEditError(`expected true or false: ${value}`);
    return value;
  }
  const suffix = /^-?\d+(U|L|UL)?$/.exec(t);
  if (suffix) {
    if (!/^-?\d+$/.test(value.trim())) throw new VisuEditError(`expected a whole number: ${value}`);
    return value.trim() + (suffix[1] ?? '');
  }
  if (!/^[A-Za-z_]\w*$/.test(value.trim())) throw new VisuEditError(`invalid value: ${value}`);
  return value.trim();
}

/** Text ranges to replace for the edits (on the text with BOM removed): [start, end, replacement]. */
export function editRanges(xml: string, edits: VisuEdit[]): [number, number, string][] {
  const root = parseXml(xml);
  const out: [number, number, string][] = [];
  for (const e of edits) {
    if ('visu' in e) {
      const { obj } = visualObject(root);
      const v = e.visu === 'background' ? backgroundOf(obj) : ch(sizeOf(obj), e.visu === 'width' ? 'Width' : 'Height');
      if (!v || v.name !== 'v') throw new VisuEditError(`this visualization has no stored ${e.visu}; set it once in TwinCAT`);
      if (e.visu !== 'background' && !(Number(e.value) > 0)) throw new VisuEditError(`expected a positive size: ${e.value}`);
      out.push([v.innerStart, v.innerEnd, encodeScalar(inner(xml, v), e.value, e.visu === 'background')]);
      continue;
    }
    const el = findElement(xml, root, e.element);
    if (!el) throw new VisuEditError(`element ${e.element} not found`);
    let v: XNode | undefined;
    let isColor = false;
    if ('member' in e) {
      const coll = ch(ch(el, 'VisualElemMemberList'), 'VisualElemMemberList');
      const o = coll?.children.find(c => ch(c, 'Id') && Number(scalar(inner(xml, ch(c, 'Id')!))) === e.member);
      v = ch(o, 'Value');
      isColor = /Color$/i.test(NAMES.get(e.member) ?? '');
      if (v && v.name !== 'v') throw new VisuEditError('this property is a style or structured value; change it in TwinCAT');
    } else {
      const d = ch(el, 'VisualElementInputActions');
      const items = (d?.children ?? []).filter(c => c.name !== 'v').flatMap(a => a.children.filter(x => x.name === 'o'));
      let n: XNode | undefined = items[e.action];
      for (const part of e.field.split('.')) n = ch(n, part);
      v = n;
    }
    if (!v || v.name !== 'v') throw new VisuEditError('property not found in this element; set it once in TwinCAT');
    out.push([v.innerStart, v.innerEnd, encodeScalar(inner(xml, v), e.value, isColor)]);
  }
  return out.sort((a, b) => b[0] - a[0]);
}

/** The file text with the edits applied (BOM kept). */
export function applyEdits(xml: string, edits: VisuEdit[]): string {
  const bom = xml.startsWith('﻿') ? '﻿' : '';
  let src = bom ? xml.slice(1) : xml;
  for (const [s, e, r] of editRanges(src, edits)) src = src.slice(0, s) + r + src.slice(e);
  return bom + src;
}
