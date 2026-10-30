// Webview of the text list / image pool / visualization manager editor (see src/views/plcArchiveEditor.ts).
// Every editable value is one stored scalar: an edit sends { at, old, value } and the host splices it in.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let model = null, file = '', imageBase = '', visus = [], error = '';
  let filter = saved.filter || '';

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

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'model') { model = m.model; file = m.file; imageBase = m.imageBase; visus = m.visus || []; error = ''; render(); }
    else if (m.type === 'error') { error = m.message; renderStatus(); }
  });

  const edit = (s, value) => { if (String(value) !== s.value) vscode.postMessage({ type: 'edit', edits: [{ at: s.at, old: s.raw, value: String(value) }] }); };
  const keys = (old) => (ev) => { if (ev.key === 'Enter') ev.target.blur(); if (ev.key === 'Escape') { ev.target.value = old; ev.target.blur(); } };

  /** The control for one stored value: checkbox, number, text; ids read-only. */
  function control(s, opts) {
    if (!s) return h('span', { class: 'dim', title: 'Not stored in the file; set it once in TwinCAT' }, '—');
    if (s.kind === 'guid') return h('span', { class: 'dim mono' }, s.value);
    if (s.kind === 'bool') return h('input', { type: 'checkbox', checked: s.value === 'true', onchange: (ev) => edit(s, ev.target.checked ? 'true' : 'false') });
    return h('input', { type: s.kind === 'number' ? 'number' : 'text', value: s.value, spellcheck: 'false', list: opts && opts.list, class: s.kind === 'name' ? 'mono' : '',
      onkeydown: keys(s.value), onchange: (ev) => edit(s, ev.target.value) });
  }

  // ---------- layout ----------

  const app = document.getElementById('app');
  let statusEl;

  function render() {
    const scroll = document.querySelector('.body')?.scrollTop;
    app.textContent = '';
    app.append(toolbar());
    if (!model) { app.append(h('div', { class: 'empty' }, error || 'Loading…')); return; }
    const body = h('div', { class: 'body' });
    body.append(model.kind === 'textlist' ? textList() : model.kind === 'imagepool' ? imagePool() : visuManager());
    app.append(body);
    if (scroll !== undefined) body.scrollTop = scroll;
    renderStatus();
  }

  const TITLES = { textlist: 'Text list', imagepool: 'Image pool', visumanager: 'Visualization manager' };
  function toolbar() {
    const bar = h('div', { class: 'bar' }, h('b', {}, model ? `${TITLES[model.kind]} · ${model.name}` : file));
    if (model) {
      bar.append(h('input', { class: 'filter', type: 'search', value: filter,
        placeholder: model.kind === 'textlist' ? 'Filter: id, text, translation…' : model.kind === 'imagepool' ? 'Filter: id, file…' : 'Filter settings…',
        oninput: (ev) => { filter = ev.target.value; vscode.setState({ filter }); const pos = ev.target.selectionStart; render(); const f = document.querySelector('.filter'); f.focus(); f.setSelectionRange(pos, pos); } }));
    }
    bar.append(h('span', { class: 'grow' }), statusEl = h('span', { class: 'status' }),
      h('button', { title: 'Open the YAML summary (also used for diffs)', onclick: () => vscode.postMessage({ type: 'openText' }) }, 'YAML'),
      h('button', { title: 'Open the file as XML', onclick: () => vscode.postMessage({ type: 'openXml' }) }, 'XML'));
    return bar;
  }

  function renderStatus() {
    if (!statusEl) return;
    statusEl.className = 'status' + (error ? ' err' : '');
    statusEl.textContent = error || (!model ? '' : model.kind === 'textlist' ? `${model.rows.length} texts · ${model.languages.length} languages`
      : model.kind === 'imagepool' ? `${model.items.filter(i => i.id).length} images` : `${model.settings.filter(s => s.kind !== 'guid').length} settings`);
    if (error && !model) render();
  }

  const hit = (...parts) => { const f = filter.trim().toLowerCase(); return !f || parts.join('\n').toLowerCase().includes(f); };

  // ---------- text list ----------

  function textList() {
    const wrap = h('div', {});
    if (!model.languages.length) wrap.append(h('div', { class: 'note' }, 'No languages yet. Add them in TwinCAT (text list: Add language); their translations can then be edited here.'));
    const rows = model.rows.filter(r => hit(r.id, r.text, ...r.translations.map(t => (t ? t.value : ''))));
    const table = h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', { title: 'Default text: comes from the visualizations, change it there' }, 'Default'), model.languages.map(l => h('th', {}, l)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', { class: 'mono dim' }, r.id),
        h('td', {}, r.text),
        r.translations.map((t, i) => h('td', {}, t ? control(t) : h('span', { class: 'dim', title: `No ${model.languages[i]} text stored; add it in TwinCAT` }, '—')))))));
    wrap.append(rows.length ? table : h('div', { class: 'empty' }, 'No text matches the filter.'));
    return wrap;
  }

  // ---------- image pool ----------

  const imageUrl = (p) => imageBase + '/' + p.split('/').map(encodeURIComponent).join('/');
  function imagePool() {
    const items = model.items.filter(i => (i.id || i.path) && hit(i.id, i.path));
    const empty = model.items.filter(i => !i.id && !i.path).length;
    const grid = h('div', { class: 'cards' }, items.map(i => {
      const prefix = i.file ? i.file.value.replace(/[^|]*$/, '') : '';
      const img = h('img', { src: i.path ? imageUrl(i.path) : '', alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(h('div', { class: 'missing' }, 'file not found')));
      return h('div', { class: 'card' },
        h('div', { class: 'thumb', title: 'Open the image', onclick: () => i.path && vscode.postMessage({ type: 'openImage', path: i.path }) }, img),
        h('div', { class: 'id' }, i.id || h('span', { class: 'dim' }, '(no id)'), h('span', { class: 'dim' }, ` #${i.itemId}`)),
        i.file ? h('input', { type: 'text', class: 'mono', value: i.path, spellcheck: 'false', title: 'Image file, relative to the PLC project folder',
          onkeydown: keys(i.path), onchange: (ev) => edit(i.file, prefix + ev.target.value.replace(/\//g, '\\')) }) : h('span', { class: 'dim' }, 'no file'));
    }));
    return h('div', {}, items.length ? grid : h('div', { class: 'empty' }, 'No image matches the filter.'),
      empty ? h('div', { class: 'dim pad' }, `${empty} empty entr${empty === 1 ? 'y' : 'ies'} (TwinCAT keeps them for ids).`) : '',
      h('div', { class: 'dim pad' }, 'Visualizations refer to images by their ID; add, remove or rename images in TwinCAT.'));
  }

  // ---------- visualization manager ----------

  const SECTIONS = [
    ['Start and size', ['ViewSettings.StartVisu33', 'ViewSettings.ClientSizeMode', 'ViewSettings.ClientSizeX', 'ViewSettings.ClientSizeY', 'ViewSettings.BestFit', 'UseUnicodeStrings']],
    ['Style and drawing', ['ViewSettings.VisuStyle', 'ViewSettings.SemiTransparentDrawingActive', 'ViewSettings.PaintDeactiveElementsGrayedOut', 'ViewSettings.UpdateColorvariablesAfterActivationDone',
      'ViewSettings.ConvertImages', 'ViewSettings.TransferSvgAndConvertedImages']],
    ['Input', ['ViewSettings.UseStandardKeyboardHandling', 'ViewSettings.TouchHandlingActive', 'ViewSettings.NumpadDialog', 'ViewSettings.KeypadDialog',
      'ViewSettings.InputWithLimitsDialog', 'ViewSettings.UseInputWithLimits']],
    ['User management', ['UseLocalUserMgmt', 'UseUserMgmtInPlc', 'VisuUserManagement.ApplyLoginRestrictions', 'VisuUserManagement.MaxNumberOfAutenthicationAttempts',
      'VisuUserManagement.UserLockout', 'VisuUserManagement.ChangeToStartVisuAtLogout', 'ViewSettings.LoginDialog', 'ViewSettings.ChangePasswordDialog', 'ViewSettings.ChangeConfigDialog']],
    ['Memory and clients', ['ViewSettings.MaxNumOfClients', 'ViewSettings.PaintBufferSize', 'ViewSettings.MemorybufferSize', 'ViewSettings.FileTransferMode']],
  ];
  const LABELS = { 'ViewSettings.StartVisu33': 'Start visualization', UseUnicodeStrings: 'Unicode strings', MaxNumberOfAutenthicationAttempts: 'Max. login attempts',
    MemorybufferSize: 'Memory buffer size', UseUserMgmtInPlc: 'User management in PLC', UseLocalUserMgmt: 'Local user management' };
  const label = (p) => LABELS[p] || LABELS[p.replace(/^.*\./, '')] || p.replace(/^.*\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

  function visuManager() {
    const by = new Map(model.settings.map(s => [s.path, s]));
    const row = (p, s) => h('div', { class: 'prow' }, h('label', { title: p }, label(p)),
      control(s, p === 'ViewSettings.StartVisu33' ? { list: 'visus' } : undefined));
    const wrap = h('div', { class: 'form' }, h('datalist', { id: 'visus' }, visus.map(v => h('option', { value: v }))));
    const shown = new Set();
    for (const [title, paths] of SECTIONS) {
      const rows = paths.filter(p => by.has(p) && hit(p, label(p), by.get(p).value));
      paths.forEach(p => shown.add(p));
      if (rows.length) wrap.append(h('div', { class: 'sec' }, title), ...rows.map(p => row(p, by.get(p))));
    }
    const rest = model.settings.filter(s => !shown.has(s.path) && s.kind !== 'guid' && hit(s.path, s.value));
    if (rest.length) wrap.append(h('details', { open: !!filter.trim() }, h('summary', { class: 'sec' }, `All other settings (${rest.length})`), rest.map(s => row(s.path, s))));
    wrap.append(h('div', { class: 'dim pad' }, 'Settings stored as empty (null) in the file and the target / web visualization objects are edited in TwinCAT.'));
    return wrap;
  }

  render();
  vscode.postMessage({ type: 'ready' });
})();
