// What each ADS host protocol offers, and how the extension negotiates with the iecode CLI host. Pure: no imports.
//
// Rules (the compatibility contract):
// - a host with protocol p works when 1 <= p <= own (own = the highest entry); its capabilities are exactly entry p;
// - a host newer than the extension is refused (the extension cannot know what the newer messages mean);
// - entries are additive and a released entry never changes.

export interface ProtocolEntry { readonly ops: readonly string[]; readonly features: readonly string[] }
export type ProtocolTable = Readonly<Record<number, ProtocolEntry>>;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Immutable. Entry N is complete: it lists everything protocol N offers, not only the change. */
export const PROTOCOL_TABLE: ProtocolTable = deepFreeze({
  1: { ops: ['watch', 'read', 'write', 'interval'], features: [] },
});

const highest = (table: ProtocolTable): number => Math.max(...Object.keys(table).map(Number));

/** The highest key of PROTOCOL_TABLE: what this extension speaks. */
export const PROTOCOL: number = highest(PROTOCOL_TABLE);

/** Words for a feature in user-facing texts; a feature without a label is printed by its id. */
export const FEATURE_LABELS: Readonly<Record<string, string>> = {};

const INSTALL = 'Update it with "IECode: Install CLI…"';

export class HostCaps {
  constructor(readonly protocol: number, private readonly table: ProtocolTable = PROTOCOL_TABLE) {}

  supportsOp(op: string): boolean {
    return this.table[this.protocol]?.ops.includes(op) ?? false;
  }

  supports(feature: string): boolean {
    return this.table[this.protocol]?.features.includes(feature) ?? false;
  }

  /** undefined when supported, else the text of featureMissingText. */
  missing(feature: string): string | undefined {
    return this.supports(feature) ? undefined : featureMissingText(feature, this.protocol, this.table);
  }
}

export type Negotiation = { ok: true; caps: HostCaps } | { ok: false; error: string; action?: 'install' };

export function negotiate(hostProtocol: unknown, table: ProtocolTable = PROTOCOL_TABLE): Negotiation {
  const own = highest(table);
  if (typeof hostProtocol === 'number' && Number.isInteger(hostProtocol) && hostProtocol > own) {
    return { ok: false, error: `The iecode CLI speaks ADS host protocol ${hostProtocol}, newer than this extension (${own}). Update the extension.` };
  }
  if (typeof hostProtocol !== 'number' || !Number.isInteger(hostProtocol) || hostProtocol < 1 || !table[hostProtocol]) {
    return { ok: false, error: `The iecode CLI sent an unknown ADS host protocol version (${JSON.stringify(hostProtocol) ?? 'undefined'}). Update the iecode CLI with "IECode: Install CLI…".`, action: 'install' };
  }
  return { ok: true, caps: new HostCaps(hostProtocol, table) };
}

/** Starts in lower case and has no final period, so it reads after `Not written: `. */
export function featureMissingText(feature: string, installedProtocol: number, table: ProtocolTable = PROTOCOL_TABLE): string {
  const label = FEATURE_LABELS[feature] ?? feature;
  const since = Object.keys(table).map(Number).sort((a, b) => a - b).find(p => table[p].features.includes(feature));
  return since === undefined
    ? `this needs a newer iecode CLI: ${label}. ${INSTALL}`
    : `this needs a newer iecode CLI: ${label} (installed: ADS host protocol ${installedProtocol}, needed: ${since}). ${INSTALL}`;
}

/** Violations of the table rules (numbering gaps, an entry that drops something the previous one had, an empty entry); [] = fine. */
export function tableProblems(table: ProtocolTable): string[] {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  const out: string[] = [];
  keys.forEach((k, i) => {
    if (k !== i + 1) out.push(`gap in the numbering: expected protocol ${i + 1}, found ${k}`);
    if (!table[k].ops.length) out.push(`protocol ${k} has no ops`);
    const prev = table[k - 1];
    if (!prev) return;
    for (const x of prev.ops) if (!table[k].ops.includes(x)) out.push(`protocol ${k} drops "${x}"`);
    for (const x of prev.features) if (!table[k].features.includes(x)) out.push(`protocol ${k} drops "${x}"`);
  });
  return out;
}
