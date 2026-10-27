// Webview of the TwinCAT visualization editor (see src/views/visuEditor.ts).
// Modes: "canvas" draws the elements (select, drag to move, corner handle to resize, arrow keys to nudge);
// "simple" lists what every element shows and does. Both edit through the property panel.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    mode: saved.mode || 'canvas',
    zoom: saved.zoom || 'fit',
    vars: saved.vars !== undefined ? saved.vars : true,
    wire: !!saved.wire,
    frames: saved.frames !== undefined ? saved.frames : true,
    filter: '',
    sel: saved.sel || null,
    tabs: {},            // selected tab per tab control guid
  };
  let visu = null, file = '';
  const refs = {};       // referenced visualization name -> Visu | null (null: not in workspace)
  const pending = new Set();
  let error = '';

  const save = () => vscode.setState({ mode: ui.mode, zoom: ui.zoom, vars: ui.vars, wire: ui.wire, frames: ui.frames, sel: ui.sel });
  const SVG = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const c of kids.flat(Infinity)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  // ---------- model helpers ----------

  const all = (els) => els.flatMap(e => [e, ...all(e.children)]);
  const byGuid = (g) => visu && all(visu.elements).find(e => e.guid === g);
  const member = (e, path) => e.members.find(m => m.path === path);
  const tabsOf = (e) => e.params.filter(m => /\.pstTabTitle$/.test(m.label))
    .map(m => ({ title: m.value, visu: m.label.replace(/(\[\d+\])?\.pstTabTitle$/, '') }));
  const shownParams = (e) => e.params.filter(m => !/\.(sTextId|sImageId|pstTabTitle)$/.test(m.label));
  const lastSeg = (v) => v.replace(/^.*\./, '');
  /** Text as shown: format specifiers replaced by the variable (when enabled). */
  function shownText(e) {
    let t = e.text || '';
    if (ui.vars && e.textVar && /%[-+ 0#]*\d*(\.\d+)?[a-zA-Z]/.test(t)) t = t.replace(/%[-+ 0#]*\d*(\.\d+)?[a-zA-Z]/, '‹' + lastSeg(e.textVar) + '›');
    else if (ui.vars && e.textVar && !t) t = '‹' + lastSeg(e.textVar) + '›';
    return t.replace(/%%/g, '%');
  }

  // ---------- messages ----------

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'model') { visu = m.visu; file = m.file; error = ''; if (ui.sel && !byGuid(ui.sel)) ui.sel = null; render(); requestRefs(); }
    else if (m.type === 'refs') { Object.assign(refs, m.visus); Object.keys(m.visus).forEach(n => pending.delete(n)); render(); requestRefs(); }
    else if (m.type === 'error') { error = m.message; renderStatus(); }
  });

  /** Asks the host for referenced visualizations that are drawn (frames, up to 3 levels deep). */
  function requestRefs() {
    if (!visu || !ui.frames || ui.wire) return;
    const want = new Set();
    const walk = (els, depth) => {
      for (const e of all(els)) {
        const tabs = tabsOf(e);
        const names = tabs.length ? [tabs[Math.min(ui.tabs[e.guid] || 0, tabs.length - 1)].visu] : e.refs.slice(0, 1);
        for (const n of names) {
          if (!(n in refs)) want.add(n);
          else if (refs[n] && depth < 3) walk(refs[n].elements, depth + 1);
        }
      }
    };
    walk(visu.elements, 1);
    const names = [...want].filter(n => !pending.has(n));
    if (!names.length) return;
    names.forEach(n => pending.add(n));
    vscode.postMessage({ type: 'refs', names });
  }

  function edit(edits) { if (edits.length) vscode.postMessage({ type: 'edit', edits }); }
  const editMember = (e, m, value) => edit([{ element: e.guid, member: m.id, value: String(value) }]);

  // ---------- layout ----------

  const app = document.getElementById('app');
  let stage, svgEl, overlay, statusEl, propsEl, scale = 1;

  function render() {
    const scroll = stage ? { l: stage.scrollLeft, t: stage.scrollTop } : null;
    const listScroll = document.querySelector('.list')?.scrollTop;
    app.textContent = '';
    app.append(toolbar());
    if (!visu) { app.append(h('div', { class: 'empty' }, error || 'Loading…')); return; }
    const main = h('div', { class: 'main' });
    if (ui.mode === 'canvas') main.append(outline(), canvas(), props());
    else main.append(simple(), props());
    app.append(main);
    if (scroll && ui.mode === 'canvas') { stage.scrollLeft = scroll.l; stage.scrollTop = scroll.t; }
    if (listScroll !== undefined && ui.mode === 'simple') document.querySelector('.list').scrollTop = listScroll;
    renderStatus();
  }

  function toolbar() {
    const btn = (label, title, on, active) => h('button', { class: active ? 'on' : '', title, onclick: on }, label);
    const chk = (label, key, title) => h('label', { class: 'chk', title },
      h('input', { type: 'checkbox', checked: ui[key], onchange: (ev) => { ui[key] = ev.target.checked; save(); render(); requestRefs(); } }), label);
    const bar = h('div', { class: 'bar' },
      h('span', { class: 'seg' },
        btn('Canvas', 'Draw the visualization', () => { ui.mode = 'canvas'; save(); render(); }, ui.mode === 'canvas'),
        btn('Simplified', 'List what each element shows and does', () => { ui.mode = 'simple'; save(); render(); }, ui.mode === 'simple')),
    );
    if (ui.mode === 'canvas') {
      bar.append(h('span', { class: 'seg' },
        btn('−', 'Zoom out', () => setZoom(curZoom() / 1.25)),
        btn(ui.zoom === 'fit' ? 'Fit' : Math.round(curZoom() * 100) + '%', 'Fit to window', () => setZoom('fit'), ui.zoom === 'fit'),
        btn('+', 'Zoom in', () => setZoom(curZoom() * 1.25))),
      chk('Variables', 'vars', 'Show the variable instead of the format string (%s, %.2f …)'),
      chk('Frame contents', 'frames', 'Draw the visualizations shown in frames and tab controls (from this workspace)'),
      chk('Wireframe', 'wire', 'Simplified drawing: outlines, kinds and variables only'));
    } else {
      bar.append(h('input', { class: 'filter', type: 'search', placeholder: 'Filter: name, text, variable, visualization…', value: ui.filter,
        oninput: (ev) => { ui.filter = ev.target.value; const pos = ev.target.selectionStart; render(); const f = document.querySelector('.filter'); f.focus(); f.setSelectionRange(pos, pos); } }),
      chk('Variables', 'vars', 'Show the variable instead of the format string (%s, %.2f …)'));
    }
    bar.append(h('span', { class: 'grow' }),
      statusEl = h('span', { class: 'status' }),
      btn('YAML', 'Open the simplified text of this visualization (also used for diffs)', () => vscode.postMessage({ type: 'openText' })),
      btn('XML', 'Open the file as XML', () => vscode.postMessage({ type: 'openXml' })));
    return bar;
  }

  function renderStatus() {
    if (!statusEl) return;
    statusEl.className = 'status' + (error ? ' err' : '');
    statusEl.textContent = error || (visu ? `${visu.name} · ${visu.width} × ${visu.height} · ${all(visu.elements).length} elements` : '');
    if (error && !visu) render();
  }

  const curZoom = () => (ui.zoom === 'fit' ? scale : ui.zoom);
  function setZoom(z) { ui.zoom = z === 'fit' ? 'fit' : Math.min(8, Math.max(0.1, z)); save(); render(); }

  // ---------- outline ----------

  function outline() {
    const tree = h('div', { class: 'outline' });
    const item = (e, depth) => {
      const row = h('div', { class: 'row' + (e.guid === ui.sel ? ' sel' : ''), style: `padding-left:${6 + depth * 12}px`, title: e.type,
        onclick: () => select(e.guid, true) },
        h('span', { class: 'kind k-' + kindClass(e) }, kindIcon(e)), ' ', e.name || e.kind,
        h('span', { class: 'dim' }, ' ' + (e.text ? shownText(e) : e.refs[0] ? '→ ' + lastSeg(e.refs[0]) : '')));
      tree.append(row);
      e.children.forEach(c => item(c, depth + 1));
    };
    visu.elements.slice().reverse().forEach(e => item(e, 0));   // topmost first, like TwinCAT's element list
    return tree;
  }
  const kindClass = (e) => e.kind.toLowerCase().replace(/[^a-z]/g, '');
  const ICONS = { Rectangle: '▭', 'Rounded rectangle': '▢', Ellipse: '◯', Line: '╱', Textfield: 'T', Label: 'A', Button: '⏺', Frame: '⧉',
    Group: '⊞', 'Group box': '▣', 'Tab control': '⊟', Table: '▦', Image: '🖼', Checkbox: '☑', 'Combo box': '▾' };
  const kindIcon = (e) => ICONS[e.kind] || '◇';

  // ---------- canvas ----------

  function canvas() {
    stage = h('div', { class: 'stage', tabindex: 0 });
    stage.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      if (ui.zoom === 'fit') {
        const z = Math.min((stage.clientWidth - 24) / visu.width, (stage.clientHeight - 24) / visu.height);
        if (Math.abs(z - scale) > 0.001 && z > 0) { scale = z; drawSvg(); }
      }
    });
    if (ui.zoom !== 'fit') scale = ui.zoom;
    drawSvg();
    return stage;
  }

  function drawSvg() {
    stage.textContent = '';
    svgEl = s('svg', { width: Math.round(visu.width * scale), height: Math.round(visu.height * scale), viewBox: `0 0 ${visu.width} ${visu.height}`, class: 'visu' + (ui.wire ? ' wire' : '') });
    svgEl.append(s('rect', { x: 0, y: 0, width: visu.width, height: visu.height, fill: ui.wire ? 'none' : visu.background, class: 'bg' }));
    const layer = s('g', {});
    visu.elements.forEach(e => layer.append(drawElement(e, 0, true)));
    svgEl.append(layer, overlay = s('g', { class: 'overlay' }));
    svgEl.addEventListener('pointerdown', onPointerDown);
    stage.append(svgEl);
    drawSelection();
  }

  let clipId = 0;
  /** One element (and its children) as SVG; `live`: the edited visualization (selectable), else a frame's content. */
  function drawElement(e, depth, live) {
    const r = e.rect;
    const g = s('g', { transform: `translate(${r.x},${r.y})` + (r.angle ? ` rotate(${r.angle},${r.w / 2},${r.h / 2})` : '') });
    if (live) g.dataset.guid = e.guid;
    const wire = ui.wire;
    const fill = wire || e.noFill || !e.fill ? 'none' : e.fill.rgb;
    const stroke = wire ? 'var(--wire)' : e.noFrame || !e.frame ? 'none' : e.frame.rgb;
    const sw = wire ? 1 / scale : Math.max(e.lineWidth || 1, 0) || 1;
    const box = (extra) => s('rect', Object.assign({ x: 0, y: 0, width: Math.max(r.w, 0), height: Math.max(r.h, 0), fill, stroke, 'stroke-width': sw, 'vector-effect': wire ? 'non-scaling-stroke' : undefined }, extra || {}));

    switch (e.kind) {
      case 'Ellipse': g.append(s('ellipse', { cx: r.w / 2, cy: r.h / 2, rx: Math.abs(r.w / 2), ry: Math.abs(r.h / 2), fill, stroke, 'stroke-width': sw })); break;
      case 'Rounded rectangle': g.append(box({ rx: Math.min(10, r.w / 4), ry: Math.min(10, r.h / 4) })); break;
      case 'Line': g.append(s('line', { x1: 0, y1: 0, x2: r.w, y2: r.h, stroke: stroke === 'none' ? '#000' : stroke, 'stroke-width': sw })); break;
      case 'Frame': {
        const content = frameContent(e, r.w, r.h, depth, e.refs[0]);
        if (content) g.append(content);
        if (!content || wire) g.append(box({ fill: wire ? 'none' : 'var(--frame-fill)', stroke: 'var(--frame-stroke)', 'stroke-dasharray': '4 3', 'stroke-width': 1 / Math.max(scale, 0.01), 'vector-effect': 'non-scaling-stroke' }));
        if (!content || wire) g.append(label(e.refs.map(lastSeg).join(', ') || 'Frame', r.w, r.h, 'HCENTER', 'VCENTER', 'var(--frame-text)', 11));
        else if (!e.noFrame && e.frame) g.append(box({ fill: 'none' }));
        break;
      }
      case 'Tab control': {
        const tabs = tabsOf(e);
        const cur = Math.min(ui.tabs[e.guid] || 0, Math.max(tabs.length - 1, 0));
        const th = 22, tw = Math.min(110, r.w / Math.max(tabs.length, 1));
        g.append(box({ fill: wire ? 'none' : '#f3f3f3' }));
        // hit area below the tab headers, so a click on a header switches the tab
        if (live) g.append(s('rect', { x: 0, y: 0, width: Math.max(r.w, 2), height: Math.max(r.h, 2), class: 'hit' }));
        tabs.forEach((t, i) => {
          const tg = s('g', { transform: `translate(${i * tw},0)`, class: 'tab' });
          tg.append(s('rect', { x: 0, y: 0, width: tw, height: th, fill: wire ? 'none' : i === cur ? '#ffffff' : '#dcdcdc', stroke: wire ? 'var(--wire)' : '#a0a0a0', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
          tg.append(label(t.title, tw, th, 'HCENTER', 'VCENTER', wire ? 'var(--wire-text)' : '#000', 11));
          if (live) tg.dataset.tab = `${e.guid}:${i}`;
          g.append(tg);
        });
        const content = tabs[cur] ? frameContent(e, r.w, r.h - th, depth, tabs[cur].visu) : null;
        if (content) g.append(s('g', { transform: `translate(0,${th})` }, content));
        break;
      }
      case 'Group': break;
      case 'Group box': {
        g.append(box({ fill: 'none', stroke: wire ? 'var(--wire)' : '#a0a0a0' }));
        if (e.text) {
          const t = label(shownText(e), r.w - 16, 16, 'LEFT', 'VCENTER', wire ? 'var(--wire-text)' : e.font.color, e.font.size);
          t.setAttribute('transform', 'translate(8,-8)');
          g.append(t);
        }
        break;
      }
      case 'Table': {
        g.append(box({ fill: wire ? 'none' : '#ffffff', stroke: wire ? 'var(--wire)' : '#808080' }));
        const cols = e.columns.length ? e.columns : ['Column'];
        const cw = r.w / cols.length;
        cols.forEach((c, i) => {
          g.append(s('rect', { x: i * cw, y: 0, width: cw, height: 20, fill: wire ? 'none' : '#e6e6e6', stroke: wire ? 'var(--wire)' : '#a0a0a0', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
          const t = label(lastSeg(c.replace(/\[INDEX\]/g, '')), cw, 20, 'HCENTER', 'VCENTER', wire ? 'var(--wire-text)' : '#000', 11);
          t.setAttribute('transform', `translate(${i * cw},0)`);
          g.append(t);
        });
        break;
      }
      case 'Image': {
        g.append(box({ fill: wire ? 'none' : 'var(--img-fill)', stroke: 'var(--frame-stroke)', 'stroke-dasharray': '2 2', 'vector-effect': 'non-scaling-stroke', 'stroke-width': 1 }));
        const id = (member(e, 'm_stStaticID') || member(e, 'm_BitmapInfo.m_stStaticID') || {}).value;
        g.append(label('🖼 ' + (id || 'Image'), r.w, r.h, 'HCENTER', 'VCENTER', 'var(--frame-text)', 11));
        break;
      }
      case 'Checkbox': {
        const b = Math.min(14, r.h);
        g.append(s('rect', { x: 2, y: (r.h - b) / 2, width: b, height: b, fill: wire ? 'none' : '#fff', stroke: wire ? 'var(--wire)' : '#333', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
        const t = label(shownText(e) || (ui.vars && (member(e, 'm_pVariable..pVariable') || {}).value) || '', r.w - b - 8, r.h, 'LEFT', 'VCENTER', wire ? 'var(--wire-text)' : e.font.color, e.font.size);
        t.setAttribute('transform', `translate(${b + 6},0)`);
        g.append(t);
        break;
      }
      case 'Combo box': {
        g.append(box({ fill: wire ? 'none' : '#fff', stroke: wire ? 'var(--wire)' : '#7a7a7a' }));
        g.append(s('path', { d: `M${r.w - 14},${r.h / 2 - 2} l4,4 l4,-4`, fill: 'none', stroke: wire ? 'var(--wire)' : '#333', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke' }));
        const v = (member(e, 'm_pVariable..pVarNumber') || member(e, 'm_pVariable..pVariable') || {}).value;
        g.append(label(ui.vars && v ? '‹' + lastSeg(v) + '›' : '', r.w - 18, r.h, 'LEFT', 'VCENTER', wire ? 'var(--wire-text)' : '#000', e.font.size, 4));
        break;
      }
      default:
        if (e.kind === 'Button' && !wire) g.append(box({ fill: e.fill && !e.noFill ? e.fill.rgb : '#e1e1e1', stroke: e.frame && !e.noFrame ? e.frame.rgb : '#8a8a8a', rx: 2 }));
        else g.append(box());
    }

    // text of simple elements, text fields, labels, buttons
    if (!/^(Frame|Tab control|Group box|Table|Image|Checkbox|Combo box|Group)$/.test(e.kind)) {
      const t = shownText(e);
      if (t) g.append(label(t, r.w, r.h, e.align.h, e.align.v, wire ? 'var(--wire-text)' : e.font.color, e.font.size));
      else if (wire && !/^(Rectangle|Ellipse|Rounded rectangle|Line)$/.test(e.kind) && r.h > 10) g.append(label(e.kind, r.w, r.h, 'LEFT', 'TOP', 'var(--wire-dim)', 9, 2));
    }
    if (wire && live && /^(Rectangle|Ellipse|Rounded rectangle|Group)$/.test(e.kind) && e.name && r.w > 40 && r.h > 14 && !e.children.length) {
      g.append(label(e.name, r.w, r.h, 'LEFT', 'TOP', 'var(--wire-dim)', 9, 2));
    }
    e.children.forEach(c => g.append(drawElement(c, depth, live)));
    // hit area for the whole box (also for transparent elements)
    if (live && e.kind !== 'Tab control') g.append(s('rect', { x: 0, y: 0, width: Math.max(r.w, 2), height: Math.max(r.h, 2), class: 'hit' + (e.children.length ? ' container' : '') }));
    return g;
  }

  /** The visualization shown in a frame / tab, scaled into w × h (null: not drawn). */
  function frameContent(e, w, h, depth, name) {
    if (!name || ui.wire || !ui.frames || depth >= 3) return null;
    const v = refs[name];
    if (!v) return null;
    const iso = (member(e, 'm_nIsotropicType') || {}).value;
    let sx = w / v.width, sy = h / v.height;
    if (iso === 'ISOTROPIC') sx = sy = Math.min(sx, sy);
    else if (iso === 'FIXED' || iso === 'FIXED_AND_SCROLL' || iso === 'SCROLLABLE') sx = sy = 1;
    const id = 'c' + (clipId++);
    const g = s('g', { 'clip-path': `url(#${id})`, class: 'framed' });
    g.append(s('clipPath', { id }, s('rect', { x: 0, y: 0, width: w, height: h })));
    const inner = s('g', { transform: `scale(${sx},${sy})` });
    inner.append(s('rect', { x: 0, y: 0, width: v.width, height: v.height, fill: v.background }));
    v.elements.forEach(c => inner.append(drawElement(c, depth + 1, false)));
    g.append(inner);
    return g;
  }

  function label(text, w, hgt, ha, va, color, size, pad) {
    pad = pad === undefined ? 2 : pad;
    const x = ha === 'LEFT' ? pad : ha === 'RIGHT' ? w - pad : w / 2;
    const anchor = ha === 'LEFT' ? 'start' : ha === 'RIGHT' ? 'end' : 'middle';
    const lines = String(text).split(/\r?\n/);
    const lh = (size || 12) * 1.15;
    const total = lh * lines.length;
    const y0 = va === 'TOP' ? pad + lh * 0.8 : va === 'BOTTOM' ? hgt - pad - total + lh * 0.8 : (hgt - total) / 2 + lh * 0.8;
    const id = 'c' + (clipId++);
    const g = s('g', { 'clip-path': `url(#${id})` });
    g.append(s('clipPath', { id }, s('rect', { x: 0, y: 0, width: Math.max(w, 0), height: Math.max(hgt, 0) })));
    const t = s('text', { x, y: y0, 'text-anchor': anchor, fill: color || '#000', 'font-size': size || 12, class: 'txt' });
    lines.forEach((l, i) => t.append(s('tspan', { x, dy: i ? lh : 0 }, l)));
    g.append(t);
    return g;
  }

  /** Absolute position of an element (parents' offsets added). */
  function absRect(guid) {
    const walk = (els, ox, oy) => {
      for (const e of els) {
        if (e.guid === guid) return { x: ox + e.rect.x, y: oy + e.rect.y, w: e.rect.w, h: e.rect.h };
        const r = walk(e.children, ox + e.rect.x, oy + e.rect.y);
        if (r) return r;
      }
      return null;
    };
    return walk(visu.elements, 0, 0);
  }

  function drawSelection(live) {
    if (!overlay) return;
    overlay.textContent = '';
    if (!ui.sel) return;
    const r = live || absRect(ui.sel);
    if (!r) return;
    const k = 1 / scale;
    overlay.append(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 'selbox', 'vector-effect': 'non-scaling-stroke' }));
    overlay.append(s('rect', { x: r.x + r.w - 4 * k, y: r.y + r.h - 4 * k, width: 8 * k, height: 8 * k, class: 'handle' }));
    if (live) overlay.append(s('text', { x: r.x, y: r.y - 4 * k, class: 'coord', 'font-size': 11 * k }, `${r.rx}, ${r.ry}  ${r.w} × ${r.h}`));
  }

  // ---------- canvas interaction ----------

  let drag = null;
  const toVisu = (ev) => { const b = svgEl.getBoundingClientRect(); return { x: (ev.clientX - b.left) / scale, y: (ev.clientY - b.top) / scale }; };

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    stage.focus({ preventScroll: true });
    const p = toVisu(ev);
    if (ev.target.classList && ev.target.classList.contains('handle') && ui.sel) {
      const e = byGuid(ui.sel);
      drag = { mode: 'resize', e, p, abs: absRect(ui.sel), moved: false };
    } else {
      const tab = ev.target.closest && ev.target.closest('[data-tab]');
      if (tab && !ev.altKey) {
        const [g, i] = tab.dataset.tab.split(':');
        ui.tabs[g] = Number(i);
        select(g, false);
        drawSvg();
        requestRefs();
        return;
      }
      const hit = ev.target.closest && ev.target.closest('[data-guid]');
      if (!hit) { select(null); return; }
      // a click on a group selects the group; alt-click selects the element inside
      let g = hit.dataset.guid;
      if (!ev.altKey) {
        let n = hit;
        while (n.parentNode && n.parentNode.closest && n.parentNode.closest('[data-guid]')) n = n.parentNode.closest('[data-guid]');
        if (n !== hit && byGuid(n.dataset.guid).kind === 'Group' && !isInside(ui.sel, n.dataset.guid)) g = n.dataset.guid;
      }
      select(g, false);
      const e = byGuid(g);
      drag = { mode: 'move', e, p, abs: absRect(g), moved: false };
    }
    svgEl.setPointerCapture(ev.pointerId);
    svgEl.addEventListener('pointermove', onPointerMove);
    svgEl.addEventListener('pointerup', onPointerUp, { once: true });
  }
  const isInside = (guid, groupGuid) => { const g = byGuid(groupGuid); return !!guid && !!g && all(g.children).some(c => c.guid === guid); };

  function onPointerMove(ev) {
    if (!drag) return;
    const p = toVisu(ev);
    const dx = Math.round(p.x - drag.p.x), dy = Math.round(p.y - drag.p.y);
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    drag.moved = true;
    const r = drag.e.rect, a = drag.abs;
    const node = svgEl.querySelector(`[data-guid="${drag.e.guid}"]`);
    if (drag.mode === 'move') {
      drag.d = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
      node.setAttribute('transform', `translate(${drag.d.x},${drag.d.y})` + (r.angle ? ` rotate(${r.angle},${r.w / 2},${r.h / 2})` : ''));
      drawSelection({ x: a.x + dx, y: a.y + dy, w: r.w, h: r.h, rx: drag.d.x, ry: drag.d.y });
    } else {
      drag.d = { x: r.x, y: r.y, w: Math.max(1, r.w + dx), h: Math.max(1, r.h + dy) };
      drawSelection({ x: a.x, y: a.y, w: drag.d.w, h: drag.d.h, rx: r.x, ry: r.y });
    }
  }

  function onPointerUp() {
    svgEl.removeEventListener('pointermove', onPointerMove);
    const d = drag;
    drag = null;
    if (!d || !d.moved || !d.d) { drawSelection(); return; }
    moveTo(d.e, d.d);
  }

  /** Edits for a new position / size (the rotation center moves along). */
  function moveTo(e, n) {
    const r = e.rect, out = [];
    const put = (path, v) => { const m = member(e, path); if (m && m.raw !== undefined && String(v) !== m.value) out.push({ element: e.guid, member: m.id, value: String(v) }); };
    put('m_StaticPosition.iX', n.x); put('m_StaticPosition.iY', n.y);
    put('m_StaticPosition.iWidth', n.w); put('m_StaticPosition.iHeight', n.h);
    const cx = member(e, 'm_StaticCenter.iX'), cy = member(e, 'm_StaticCenter.iY');
    if (cx && cy) {
      put('m_StaticCenter.iX', Math.round(Number(cx.value) + (n.x - r.x) + (n.w - r.w) / 2));
      put('m_StaticCenter.iY', Math.round(Number(cy.value) + (n.y - r.y) + (n.h - r.h) / 2));
    }
    if (!out.length && (n.x !== r.x || n.y !== r.y || n.w !== r.w || n.h !== r.h)) error = 'This element has no stored position; move it once in TwinCAT.';
    edit(out);
  }

  function onKey(ev) {
    if (!ui.sel || ev.target !== stage) return;
    const step = ev.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (ev.key === 'Escape') { select(null); return; }
    if (!d) return;
    ev.preventDefault();
    const e = byGuid(ui.sel);
    if (ev.altKey) moveTo(e, { x: e.rect.x, y: e.rect.y, w: Math.max(1, e.rect.w + d[0]), h: Math.max(1, e.rect.h + d[1]) });
    else moveTo(e, { x: e.rect.x + d[0], y: e.rect.y + d[1], w: e.rect.w, h: e.rect.h });
  }

  function select(guid, reveal) {
    ui.sel = guid;
    save();
    if (ui.mode === 'canvas') {
      document.querySelectorAll('.outline .row.sel').forEach(r => r.classList.remove('sel'));
      drawSelection();
      const old = document.querySelector('.props');
      if (old) old.replaceWith(props());
      const rows = [...document.querySelectorAll('.outline .row')];
      const flat = visu.elements.slice().reverse().flatMap(function f(e) { return [e, ...e.children.flatMap(f)]; });
      const i = flat.findIndex(e => e.guid === guid);
      if (rows[i]) { rows[i].classList.add('sel'); rows[i].scrollIntoView({ block: 'nearest' }); }
      if (reveal && guid && stage) {
        const r = absRect(guid);
        if (r) {
          const x = r.x * scale, y = r.y * scale;
          if (x < stage.scrollLeft || x > stage.scrollLeft + stage.clientWidth - 40 || y < stage.scrollTop || y > stage.scrollTop + stage.clientHeight - 40) {
            stage.scrollLeft = x - 40; stage.scrollTop = y - 40;
          }
        }
      }
    } else render();
  }

  // ---------- simplified list ----------

  function matches(e, f) {
    if (!f) return true;
    const hay = [e.name, e.kind, e.identifier, e.text, e.tooltip, e.textVar, e.tooltipVar, ...e.refs,
      ...e.params.map(m => m.label + ' ' + m.value), ...e.variables.map(m => m.value),
      ...e.actions.flatMap(a => [a.kind, ...a.fields.map(x => x.value)])].join('\n').toLowerCase();
    return hay.includes(f);
  }

  function simple() {
    const f = ui.filter.trim().toLowerCase();
    const list = h('div', { class: 'list' });
    if (visu.declaration.trim() && !f) list.append(h('details', { class: 'decl' }, h('summary', {}, 'Interface'), h('pre', {}, visu.declaration)));
    const card = (e, depth) => {
      const kids = e.children.map(c => card(c, depth + 1)).filter(Boolean);
      if (!matches(e, f) && !kids.length) return null;
      const lines = [];
      const field = (lbl, m, val, cls) => lines.push(h('div', { class: 'ln' }, h('span', { class: 'lbl' }, lbl), m && m.raw !== undefined
        ? inlineInput(e, m, cls) : h('span', { class: 'val ' + (cls || '') }, val)));
      const text = member(e, 'm_StaticTexts.pstText');
      if (e.text || (text && /Textfield|Label|Button|Group box|Checkbox/.test(e.kind))) field('Text', text, e.text);
      const tv = member(e, 'm_pTextChanges..pVarText');
      if (e.textVar || (tv && /%/.test(e.text))) field('Variable', tv, e.textVar, 'var');
      if (e.tooltip) field('Tooltip', member(e, 'm_StaticTexts.pstToolTip'), e.tooltip);
      const tabs = tabsOf(e);
      if (tabs.length) lines.push(h('div', { class: 'ln' }, h('span', { class: 'lbl' }, 'Tabs'), h('span', { class: 'val' }, tabs.map((t, i) => [i ? ', ' : '', t.title + ' ', refLink(t.visu)]))));
      else if (e.refs.length) lines.push(h('div', { class: 'ln' }, h('span', { class: 'lbl' }, 'Shows'), h('span', { class: 'val' }, e.refs.map((n, i) => [i ? ', ' : '', refLink(n)]))));
      for (const m of shownParams(e)) field(m.label.replace(/^.*?\.(?=[^.\[]+$)/, ''), m, m.value, 'var');
      const pids = new Set(e.params.map(m => m.id));
      for (const m of e.variables) if (!pids.has(m.id) && m.path !== 'm_pTextChanges..pVarText' && m.path !== 'm_pTextChanges..pVarTooltip') field(m.label, m, m.value, 'var');
      if (e.columns.length) lines.push(h('div', { class: 'ln' }, h('span', { class: 'lbl' }, 'Columns'), h('span', { class: 'val var' }, e.columns.join(', '))));
      e.actions.forEach((a, i) => {
        const fs = a.fields.filter(x => x.value !== '' && x.value !== 'false' && !/^(Dialog|InputType|TextOutputVariableInitialized|UseTextOutputVariable)/.test(x.name));
        lines.push(h('div', { class: 'ln' }, h('span', { class: 'lbl' }, 'On ' + a.event.replace(/^On/, '')),
          h('span', { class: 'val' }, a.kind, fs.length ? ': ' : '', fs.map((x, j) => [j ? ', ' : '', h('span', { class: 'dim' }, x.name + ' '),
            x.raw.trim().startsWith('"') ? actionInput(e, i, x) : h('span', { class: 'var' }, x.value)]))));
      });
      const head = h('div', { class: 'head', onclick: () => select(e.guid) },
        h('span', { class: 'kind k-' + kindClass(e) }, kindIcon(e)), ' ', h('b', {}, e.name || e.kind), ' ',
        h('span', { class: 'dim' }, `${e.kind} · ${e.identifier} · ${e.rect.x}, ${e.rect.y} · ${e.rect.w} × ${e.rect.h}`));
      return h('div', { class: 'card' + (e.guid === ui.sel ? ' sel' : ''), style: `margin-left:${depth * 18}px` }, head, lines, kids);
    };
    const cards = visu.elements.map(e => card(e, 0)).filter(Boolean);
    list.append(...(cards.length ? cards : [h('div', { class: 'empty' }, 'No element matches the filter.')]));
    return list;
  }

  const refLink = (name) => h('a', { href: '#', title: 'Open ' + name, onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); vscode.postMessage({ type: 'openRef', name }); } }, name);

  function inlineInput(e, m, cls) {
    return h('input', { class: 'inl ' + (cls || ''), value: m.value, spellcheck: 'false', onclick: (ev) => ev.stopPropagation(),
      onkeydown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); if (ev.key === 'Escape') { ev.target.value = m.value; ev.target.blur(); } },
      onchange: (ev) => editMember(e, m, ev.target.value) });
  }
  function actionInput(e, index, f) {
    return h('input', { class: 'inl var', value: f.value, spellcheck: 'false', onclick: (ev) => ev.stopPropagation(),
      onkeydown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); },
      onchange: (ev) => edit([{ element: e.guid, action: index, field: f.name, value: ev.target.value }]) });
  }

  // ---------- property panel ----------

  function props() {
    propsEl = h('div', { class: 'props' });
    const e = ui.sel && byGuid(ui.sel);
    if (!e) {
      propsEl.append(h('div', { class: 'ph' }, visu.name), h('div', { class: 'dim pad' }, 'Select an element to see and edit its properties.'),
        h('div', { class: 'pad dim' }, 'Canvas: drag to move, drag the corner handle to resize, arrow keys nudge (Shift: 10, Alt: resize). Alt-click selects inside a group.'));
      if (visu.declaration.trim()) propsEl.append(h('div', { class: 'sec' }, 'Interface'), h('pre', { class: 'decl' }, visu.declaration));
      return propsEl;
    }
    propsEl.append(h('div', { class: 'ph' }, h('span', { class: 'kind k-' + kindClass(e) }, kindIcon(e)), ' ', e.name || e.kind),
      h('div', { class: 'dim pad' }, `${e.type} · ${e.identifier}`));

    const row = (lbl, ctl) => h('div', { class: 'prow' }, h('label', {}, lbl), ctl);
    const ctl = (m, opts) => {
      if (!m) return h('span', { class: 'dim' }, '—');
      if (m.kind === 'color') {
        if (m.raw === undefined) return h('span', { class: 'swatchrow', title: 'Style color: change it in TwinCAT or in the style' },
          h('span', { class: 'swatch', style: `background:${m.value.slice(0, 7)}` }), m.value);
        return h('span', { class: 'swatchrow' }, h('input', { type: 'color', value: m.value, onchange: (ev) => editMember(e, m, ev.target.value) }), m.value);
      }
      if (m.raw === undefined) return h('span', { class: 'val' }, m.value);
      if (m.kind === 'bool') return h('input', { type: 'checkbox', checked: m.value === 'true', onchange: (ev) => editMember(e, m, ev.target.checked ? 'true' : 'false') });
      const input = h('input', { type: m.kind === 'number' ? 'number' : 'text', value: m.value, class: m.expr || (opts && opts.var) ? 'var' : '', spellcheck: 'false',
        onkeydown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); if (ev.key === 'Escape') { ev.target.value = m.value; ev.target.blur(); } },
        onchange: (ev) => editMember(e, m, ev.target.value) });
      return input;
    };
    const P = (path) => member(e, path);

    propsEl.append(h('div', { class: 'sec' }, 'Position'),
      h('div', { class: 'grid2' }, row('X', ctl(P('m_StaticPosition.iX'))), row('Y', ctl(P('m_StaticPosition.iY'))),
        row('Width', ctl(P('m_StaticPosition.iWidth'))), row('Height', ctl(P('m_StaticPosition.iHeight')))),
      P('m_StaticPosition.m_iAngle') && Number(P('m_StaticPosition.m_iAngle').value) ? row('Angle', ctl(P('m_StaticPosition.m_iAngle'))) : '');

    const texts = ['m_StaticTexts.pstText', 'm_pTextChanges..pVarText', 'm_StaticTexts.pstToolTip', 'm_pTextChanges..pVarTooltip'].filter(p => P(p));
    if (texts.length) {
      propsEl.append(h('div', { class: 'sec' }, 'Texts'));
      for (const p of texts) propsEl.append(row(P(p).label, ctl(P(p), { var: /pVar/.test(p) })));
      const f = e.font;
      propsEl.append(row('Font', h('span', { class: 'val' }, `${f.name} ${f.size}`, ' ', h('span', { class: 'swatch', style: `background:${f.color}` }))),
        row('Alignment', h('span', { class: 'val' }, `${e.align.h.toLowerCase()} / ${e.align.v.toLowerCase()}`)));
    }

    const colors = ['m_StaticColors.NormalColors.dwFillColor', 'm_StaticColors.NormalColors.dwFrameColor', 'm_StaticColors.AlarmColors.dwFillColor', 'm_StaticColors.AlarmColors.dwFrameColor', 'm_StaticElementLook.iLineWidth'].filter(p => P(p));
    if (colors.length) {
      propsEl.append(h('div', { class: 'sec' }, 'Colors'));
      for (const p of colors) propsEl.append(row(P(p).label, ctl(P(p))));
    }

    const tabs = tabsOf(e);
    if (e.refs.length || e.params.length) {
      propsEl.append(h('div', { class: 'sec' }, e.kind === 'Tab control' ? 'Tabs' : 'Frame'));
      if (tabs.length) tabs.forEach(t => propsEl.append(row(t.title, refLink(t.visu))));
      else e.refs.forEach(n => propsEl.append(row('Shows', refLink(n))));
      for (const m of shownParams(e)) propsEl.append(row(m.label.replace(/^.*?\.(?=[^.\[]+$)/, ''), ctl(m, { var: true })));
    }

    const pids = new Set(e.params.map(m => m.id));
    const vars = e.variables.filter(m => !pids.has(m.id) && !/pVarText|pVarTooltip/.test(m.path || ''));
    if (vars.length) {
      propsEl.append(h('div', { class: 'sec' }, 'Variables'));
      for (const m of vars) propsEl.append(row(m.label, ctl(m, { var: true })));
    }

    if (e.actions.length) {
      propsEl.append(h('div', { class: 'sec' }, 'Input configuration'));
      e.actions.forEach((a, i) => {
        propsEl.append(h('div', { class: 'act' }, h('b', {}, a.event), ' · ', a.kind));
        for (const f of a.fields) {
          if (f.value === '' && !/Variable|Expr|Min|Max/.test(f.name)) continue;
          propsEl.append(row(f.name, f.raw.trim().startsWith('"') ? actionInput(e, i, f) : h('span', { class: 'val' }, f.value)));
        }
      });
    }

    propsEl.append(h('details', { class: 'allp' }, h('summary', { class: 'sec' }, `All properties (${e.members.length})`),
      e.members.map(m => row(h('span', { title: m.path || ('id ' + m.id) }, m.label), ctl(m)))));
    return propsEl;
  }

  window.addEventListener('resize', () => { if (ui.mode === 'canvas' && ui.zoom === 'fit' && visu) render(); });
  render();
  vscode.postMessage({ type: 'ready' });
})();
