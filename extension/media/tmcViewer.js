// Webview of the module class viewer (see src/views/tmcViewer.ts): overview, symbols and data types of a .tmc file.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const PAGE = 500;
  const MAX_DEPTH = 8;
  const saved = vscode.getState() || {};
  const ui = { tab: saved.tab || 'overview', symFilter: saved.symFilter || '', typeFilter: saved.typeFilter || '', area: saved.area || '', kind: saved.kind || '' };
  let model = null, file = '', error = '';
  let limit = PAGE, hit = null;
  const open = new Set();   // expanded rows by path
  const back = [];

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    file = m.file || file;
    if (m.type === 'model') {
      model = m.model; error = '';
      // a new build may have renamed the area the filter was on
      if (!model.modules.some(x => x.areas.some(a => a.name === ui.area))) ui.area = '';
      render();
    }
    else if (m.type === 'error') { error = m.message; render(); }
  });

  const remember = () => vscode.setState({ tab: ui.tab, symFilter: ui.symFilter, typeFilter: ui.typeFilter, area: ui.area, kind: ui.kind });

  // ---------- formatting ----------

  const size = (bits) => bits === undefined || bits === null ? '' : bits % 8 === 0 ? `${(bits / 8).toLocaleString()} B` : `${bits} bit`;
  const offset = (bits) => bits === undefined || bits === null ? '' : bits % 8 === 0 ? String(bits / 8) : `${Math.floor(bits / 8)}.${bits % 8}`;
  const cycle = (ns) => ns === undefined || ns === null ? '' : `${ns / 1e6} ms`;
  const KINDS = { struct: 'Struct / FB', enum: 'Enum', array: 'Array', alias: 'Alias', other: 'Other' };
  const props = (p) => (p || []).map(x => x.value === undefined ? x.name : `${x.name} = ${x.value}`).join('\n') || undefined;

  /** Every word of the filter occurs in one of the texts. */
  function matcher(filter) {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (...texts) => {
      if (!words.length) return true;
      const all = texts.filter(Boolean).join(' ').toLowerCase();
      return words.every(w => all.includes(w));
    };
  }

  const qualified = (t) => t.namespace ? `${t.namespace}.${t.name}` : t.name;

  /** The type's own members after the inherited ones; aliases show those of their base. */
  function membersOf(t, visited) {
    visited = visited || new Set();
    if (!t || visited.has(t)) return [];
    visited.add(t);
    if (t.kind === 'alias') return membersOf(model.types[t.baseRef], visited);
    return [...(t.extendsRef !== undefined ? membersOf(model.types[t.extendsRef], visited) : []), ...t.members];
  }

  /** Arrays and pointers are not expanded, as in the ADS interface. */
  const expandableVar = (v) => v.ref !== undefined && !/^(ARRAY|POINTER|REFERENCE)\b/.test(v.type) && expandable(model.types[v.ref]);
  const expandable = (t) => t.enumValues.length > 0 || t.methods.length > 0 || membersOf(t).length > 0;

  // ---------- navigation ----------

  const snapshot = () => ({ tab: ui.tab, symFilter: ui.symFilter, typeFilter: ui.typeFilter, area: ui.area, kind: ui.kind });

  function go(change) {
    back.push(snapshot());
    Object.assign(ui, change);
    limit = PAGE;
    render();
  }

  function goBack() {
    const s = back.pop();
    if (!s) return;
    Object.assign(ui, s);
    limit = PAGE;
    render();
  }

  function goType(ref) {
    const t = model.types[ref];
    hit = `t${ref}`;
    open.add(hit);
    go({ tab: 'types', typeFilter: t.name, kind: '' });
  }

  const link = (attrs, text, action) => h('a', Object.assign({ role: 'link', tabindex: '0', onclick: action, onkeydown: (ev) => { if (ev.key === 'Enter') action(); } }, attrs), text);

  const typeCell = (type, ref) => ref === undefined || ref === null
    ? h('span', { class: 'mono' }, type)
    : link({ class: 'mono', title: 'Show this data type' }, type, () => goType(ref));

  function nameCell(path, depth, canExpand, label, title) {
    const on = open.has(path);
    return h('div', { class: 'name', style: `padding-left:${depth * 14}px` },
      canExpand
        ? h('button', { class: 'tw', 'aria-expanded': String(on), 'aria-label': on ? 'Collapse' : 'Expand', onclick: () => { if (on) open.delete(path); else open.add(path); renderBody(); } }, on ? '▾' : '▸')
        : h('span', { class: 'tw' }),
      h('span', { class: 'mono', title }, label));
  }

  // ---------- toolbar ----------

  const app = document.getElementById('app');
  let bodyEl, countEl;
  let debounce;

  function filterBox(key, placeholder) {
    return h('input', { type: 'search', class: 'filter', placeholder, 'aria-label': placeholder, value: ui[key], oninput: (ev) => {
      ui[key] = ev.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => { limit = PAGE; remember(); renderBody(); }, 120);
    } });
  }

  function select(key, label, options) {
    return h('select', { 'aria-label': label, onchange: (ev) => { ui[key] = ev.target.value; limit = PAGE; remember(); renderBody(); } },
      options.map(([v, text]) => h('option', { value: v, selected: ui[key] === v }, text)));
  }

  function areaOptions() {
    const counts = new Map();
    for (const m of model.modules) for (const a of m.areas) counts.set(a.name, (counts.get(a.name) || 0) + a.symbols.length);
    return [['', 'All data areas'], ...[...counts].filter(([, n]) => n > 0).map(([n, c]) => [n, `${n} (${c.toLocaleString()})`])];
  }

  function toolbar() {
    const tab = (id, text) => h('button', { class: `tab${ui.tab === id ? ' on' : ''}`, 'aria-pressed': String(ui.tab === id), onclick: () => { ui.tab = id; limit = PAGE; remember(); render(); } }, text);
    const symbolCount = model ? model.modules.reduce((n, m) => n + m.areas.reduce((k, a) => k + a.symbols.length, 0), 0) : 0;
    const bar = h('div', { class: 'bar' }, h('b', {}, `Module class · ${file}`));
    if (model) {
      bar.append(h('div', { class: 'tabs' }, tab('overview', 'Overview'), tab('symbols', `Symbols (${symbolCount.toLocaleString()})`), tab('types', `Data types (${model.types.length.toLocaleString()})`)));
      if (back.length) bar.append(h('button', { title: 'Back to where you came from', onclick: goBack }, '← Back'));
      if (ui.tab === 'symbols') bar.append(filterBox('symFilter', 'Filter by name, type or comment'), select('area', 'Data area', areaOptions()));
      if (ui.tab === 'types') bar.append(filterBox('typeFilter', 'Filter by name, namespace or comment'),
        select('kind', 'Kind', [['', 'All kinds'], ...Object.entries(KINDS).filter(([k]) => model.types.some(t => t.kind === k))]));
    }
    countEl = h('span', { class: 'status' });
    bar.append(countEl, h('span', { class: 'grow' }), h('button', { title: 'Open the file in the text editor', onclick: () => vscode.postMessage({ type: 'openXml' }) }, 'Open as XML'));
    return bar;
  }

  // ---------- views ----------

  function render() {
    app.textContent = '';
    app.append(toolbar());
    bodyEl = h('div', { class: 'body' });
    app.append(bodyEl);
    renderBody();
  }

  function renderBody() {
    const scroll = bodyEl.scrollTop;
    bodyEl.textContent = '';
    countEl.textContent = '';
    if (!model) {
      bodyEl.append(h('div', { class: 'empty' + (error ? ' err' : '') }, error ? `Cannot show this file: ${error}` : 'Loading…'));
      return;
    }
    if (error) bodyEl.append(h('div', { class: 'note' }, `Showing the previous version: the file can't be read right now (${error}). It reloads when the build finishes.`));
    bodyEl.append(ui.tab === 'symbols' ? symbolsView() : ui.tab === 'types' ? typesView() : overview());
    const target = hit && bodyEl.querySelector('tr.hit');
    if (target) { target.scrollIntoView({ block: 'center' }); hit = null; } else bodyEl.scrollTop = scroll;
  }

  function moreButton(shown, total) {
    if (shown >= total) return null;
    return h('button', { class: 'more', onclick: () => { limit += PAGE; renderBody(); } }, `Show ${Math.min(PAGE, total - shown).toLocaleString()} more of ${(total - shown).toLocaleString()}`);
  }

  // ----- overview -----

  function kv(pairs) {
    return h('dl', { class: 'kv' }, pairs.filter(p => p[1] !== undefined && p[1] !== null && p[1] !== '').map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  }

  function table(head, rows, numeric) {
    return h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { class: numeric && numeric.includes(i) ? 'num' : undefined, scope: 'col' }, c)))),
      h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: numeric && numeric.includes(i) ? 'num' : undefined }, c))))));
  }

  function overview() {
    if (!model.modules.length) return h('div', { class: 'empty' }, `No modules in this file. It defines ${model.types.length.toLocaleString()} data types.`);
    return h('div', {}, model.vendor ? h('div', { class: 'sec', style: 'padding-top:0' }, `Vendor: ${model.vendor}`) : null, model.modules.map(moduleView));
  }

  function moduleView(m) {
    const contextName = (id) => (m.contexts.find(c => c.id === id) || {}).name;
    return h('section', { class: 'mod' },
      h('h2', { class: 'mono' }, m.name || '(unnamed module)'),
      kv([['Class ID', m.clsid], ['GUID', m.guid], ['Class factory', m.classFactory], ['Group', m.group], ['Init sequence', m.initSequence]]),
      m.contexts.length ? [h('div', { class: 'sec' }, 'Tasks'),
        table(['Task', 'Context', 'Cycle time', 'Priority'], m.contexts.map(c => [c.name || '', c.id ?? '', cycle(c.cycleTimeNs), c.priority ?? '']), [1, 2, 3])] : null,
      m.areas.length ? [h('div', { class: 'sec' }, 'Data areas'),
        table(['Area', 'No.', 'Type', 'Task', 'Size', 'Symbols'], m.areas.map(a => [
          a.symbols.length ? link({ title: 'Show these symbols' }, a.name, () => go({ tab: 'symbols', area: a.name, symFilter: '' })) : a.name,
          a.no ?? '', a.areaType || '', contextName(a.contextId) || (a.contextId ?? ''), a.byteSize === undefined ? '' : `${a.byteSize.toLocaleString()} B`, a.symbols.length.toLocaleString(),
        ]), [1, 4, 5])] : null,
      m.parameters.length ? [h('div', { class: 'sec' }, 'Parameters'),
        table(['Parameter', 'Type', 'Size', 'PTCID', 'Comment'], m.parameters.map(p => [
          h('span', { class: 'mono' }, p.name, p.readOnly ? [' ', h('span', { class: 'chip' }, 'read-only')] : null), typeCell(p.type, p.ref), size(p.bitSize), p.ptcid || '', p.comment || '',
        ]), [2])] : null,
      m.interfaces.length ? [h('div', { class: 'sec' }, 'Interfaces'), h('div', { class: 'mono' }, m.interfaces.join(', '))] : null,
      m.properties.length ? [h('div', { class: 'sec' }, 'Properties'), kv(m.properties.map(p => [p.name, p.value ?? '']))] : null,
      m.licenses.length ? h('details', {}, h('summary', { class: 'sec' }, `Licenses (${m.licenses.length})`), h('div', { class: 'mono' }, m.licenses.map(l => h('div', {}, l)))) : null);
  }

  // ----- symbols -----

  /** A symbol or member with its expanded members below it. */
  function varRows(v, path, depth, parentName, showArea, out) {
    const fullName = depth === 0 ? v.name : `${parentName}.${v.name}`;
    const canExpand = depth < MAX_DEPTH && expandableVar(v);
    out.push(h('tr', { class: depth ? 'child' : undefined },
      h('td', {}, nameCell(path, depth, canExpand, v.name, [fullName, props(v.properties)].filter(Boolean).join('\n'))),
      h('td', {}, typeCell(v.type, v.ref)),
      h('td', { class: 'num' }, size(v.bitSize)),
      h('td', { class: 'num' }, offset(v.bitOffs)),
      h('td', { class: 'mono' }, v.default || ''),
      showArea ? h('td', { class: 'dim' }, depth === 0 ? v.area : '') : null,
      h('td', {}, v.comment || '')));
    if (canExpand && open.has(path)) typeRows(model.types[v.ref], path, depth + 1, fullName, showArea, out);
  }

  /** The content of an expanded type. */
  function typeRows(t, path, depth, parentName, showArea, out) {
    const span = showArea ? 7 : 6;
    const line = (...kids) => out.push(h('tr', { class: 'child' }, h('td', { colspan: span, style: `padding-left:${8 + (depth * 14) + 18}px` }, kids)));
    if (t.extends) line(h('span', { class: 'dim' }, 'Extends '), typeCell(t.extends, t.extendsRef));
    if (t.kind === 'alias' || t.kind === 'array' || t.kind === 'enum') { if (t.base) line(h('span', { class: 'dim' }, t.kind === 'array' ? 'Element type ' : 'Base type '), typeCell(t.base, t.baseRef)); }
    for (const e of t.enumValues) line(h('span', { class: 'mono' }, e.text), e.value !== undefined ? h('span', { class: 'dim' }, ` = ${e.value}`) : null, e.comment ? h('span', { class: 'dim' }, `  ${e.comment}`) : null);
    membersOf(t).forEach(m => varRows(m, `${path}/${m.name}`, depth, parentName, showArea, out));
    for (const s of t.methods) line(h('span', { class: 'dim' }, 'Method '), h('span', { class: 'mono' }, s));
  }

  function symbolsView() {
    const match = matcher(ui.symFilter);
    const all = [];
    model.modules.forEach((m, mi) => m.areas.forEach((a, ai) => a.symbols.forEach((s, si) => {
      if ((!ui.area || a.name === ui.area) && match(s.name, s.type, s.comment)) all.push(Object.assign({ area: a.name, id: `s${mi}.${ai}.${si}` }, s));
    })));
    countEl.textContent = ui.symFilter || ui.area ? `${all.length.toLocaleString()} shown` : '';
    if (!all.length) return h('div', { class: 'empty' }, ui.symFilter || ui.area ? 'No symbol matches the filter.' : 'This file has no symbols.');
    const rows = [];
    all.slice(0, limit).forEach(s => varRows(s, s.id, 0, '', true, rows));
    return h('div', {},
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Type'), h('th', { class: 'num', scope: 'col' }, 'Size'), h('th', { class: 'num', scope: 'col', title: 'Byte offset, or byte.bit' }, 'Offset'), h('th', { scope: 'col' }, 'Default'), h('th', { scope: 'col' }, 'Data area'), h('th', { scope: 'col' }, 'Comment'))),
        h('tbody', {}, rows)),
      moreButton(Math.min(limit, all.length), all.length));
  }

  // ----- data types -----

  function typesView() {
    const match = matcher(ui.typeFilter);
    const all = [];
    model.types.forEach((t, i) => { if ((!ui.kind || t.kind === ui.kind) && match(qualified(t), t.comment, t.base)) all.push(i); });
    all.sort((a, b) => model.types[a].name.localeCompare(model.types[b].name));
    countEl.textContent = ui.typeFilter || ui.kind ? `${all.length.toLocaleString()} shown` : '';
    if (!all.length) return h('div', { class: 'empty' }, ui.typeFilter || ui.kind ? 'No data type matches the filter.' : 'This file defines no data types.');
    // a jump to a type must not leave it behind "Show more"
    if (hit) { const at = all.findIndex(i => `t${i}` === hit); if (at >= limit) limit = at + 1; }
    const rows = [];
    for (const i of all.slice(0, limit)) {
      const t = model.types[i], path = `t${i}`;
      const canExpand = expandable(t) || !!t.base;
      rows.push(h('tr', { class: hit === path ? 'hit' : undefined },
        h('td', {}, nameCell(path, 0, canExpand, t.name, [t.guid, props(t.properties)].filter(Boolean).join('\n') || undefined)),
        h('td', {}, KINDS[t.kind]),
        h('td', { class: 'num' }, size(t.bitSize)),
        h('td', { class: 'dim' }, t.namespace || ''),
        h('td', { colspan: 3 }, t.comment || '')));
      if (canExpand && open.has(path)) typeRows(t, path, 1, t.name, true, rows);
    }
    return h('div', {},
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Kind / Type'), h('th', { class: 'num', scope: 'col' }, 'Size'), h('th', { scope: 'col' }, 'Namespace / Offset'), h('th', { scope: 'col', colspan: 3 }, 'Comment'))),
        h('tbody', {}, rows)),
      moreButton(Math.min(limit, all.length), all.length));
  }

  render();
  vscode.postMessage({ type: 'ready' });
})();
