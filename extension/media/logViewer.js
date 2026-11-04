// Webview of the log viewer (see src/views/logViewer.ts): filter bar, virtual-scrolled table, detail pane.
// Scroll mapping, request windows and stale-reply handling come from logScroll.js, time formats, presets and debounce
// from logDisplay.js; both are loaded before this script (their top-level declarations are globals of the page).
// Log text goes into the DOM with textContent only. Keys (F8, F2, Ctrl+F2) are workbench keybindings that arrive
// as {type: 'command'} messages; the webview has no keydown handlers for them.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  /** Rows drawn above and below the visible ones. */
  const MARGIN = 5;
  const DEBOUNCE_MS = 250;
  const LEVELS = ['error', 'warning', 'info', 'debug', 'other'];
  const TIME_MODES = [['absolute', 'Absolute'], ['relative', 'Relative to first'], ['delta', 'Delta to previous']];
  /** Stripe colors of a merged view (logViewer.css .file-0 … .file-5); file i gets color i mod 6. */
  const FILE_COLORS = 6;
  const fileClass = (i) => `file-${i % FILE_COLORS}`;
  const baseName = (p) => p.split(/[\\/]/).pop();

  /** Webview-only settings, kept across a reload of the webview. */
  const saved = vscode.getState() || {};
  let timeMode = TIME_MODES.some(([v]) => v === saved.timeMode) ? saved.timeMode : 'absolute';
  let presetMinutes = saved.presetMinutes > 0 ? saved.presetMinutes : 10;
  const save = () => vscode.setState({ timeMode, presetMinutes });

  /** Creates an element; text is set with textContent, never parsed as HTML. */
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function button(text, title, onClick, cls) {
    const b = h('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function textInput(cls, placeholder, title) {
    const el = h('input', cls);
    el.type = 'text';
    el.placeholder = placeholder;
    el.title = title;
    el.spellcheck = false;
    return el;
  }

  /** A filter control: its inputs on one line, a red message under them. */
  function field(cls, parts, ...errors) {
    const f = h('div', `field ${cls}`);
    const line = h('div', 'line');
    line.append(...parts);
    f.append(line, ...errors);
    return f;
  }

  const setPressed = (b, on) => b.setAttribute('aria-pressed', String(!!on));
  const pressed = (b) => b.getAttribute('aria-pressed') === 'true';
  const post = (m) => vscode.postMessage(m);

  // ---------- filter bar ----------
  const hidden = { level: h('span', 'hiddenCount'), time: h('span', 'hiddenCount'), source: h('span', 'hiddenCount'), text: h('span', 'hiddenCount'), file: h('span', 'hiddenCount') };

  const levelButtons = {};
  for (const level of LEVELS) {
    const b = button(level, `Show ${level} entries`, () => {
      setPressed(b, !pressed(b));
      post({ type: 'filters', levels: LEVELS.filter(l => pressed(levelButtons[l])) });
    }, `toggle levelToggle level-${level}`);
    levelButtons[level] = b;
  }

  const fromInput = textInput('timeInput', 'From', 'Start of the time range, yyyy-MM-dd HH:mm:ss; empty = open');
  const toInput = textInput('timeInput', 'To', 'End of the time range, yyyy-MM-dd HH:mm:ss; empty = open');
  const fromError = h('div', 'fieldError');
  const toError = h('div', 'fieldError');
  const timeErrors = h('div', 'timeErrors');
  timeErrors.append(fromError, toError);
  const sendTime = createDebounce(() => post({ type: 'filters', fromText: fromInput.value, toText: toInput.value }), DEBOUNCE_MS);
  const minutesInput = h('input', 'minutes');
  minutesInput.type = 'number';
  minutesInput.min = '1';
  minutesInput.value = String(presetMinutes);
  minutesInput.title = 'Minutes of the First / Last preset';
  minutesInput.addEventListener('change', () => {
    const v = Number(minutesInput.value);
    if (v > 0) {
      presetMinutes = v;
      save();
    }
  });
  function preset(kind) {
    if (!state) return;
    const r = presetRange(kind, Number(minutesInput.value), state.firstTimeMs, state.lastTimeMs);
    if (!r) return;
    fromInput.value = r.from;
    toInput.value = r.to;
    sendTime.call();
    sendTime.flush();
  }

  const sourceInput = textInput('sourceInput', 'Source', 'Show sources containing this text (case-insensitive)');
  const sendSource = createDebounce(() => post({ type: 'filters', source: sourceInput.value }), DEBOUNCE_MS);

  const textQuery = textInput('textInput', 'Text', 'Show entries containing this text');
  const regexToggle = button('.*', 'Use regular expression', () => toggleQueryOption(regexToggle), 'toggle option');
  const caseToggle = button('Aa', 'Match case', () => toggleQueryOption(caseToggle), 'toggle option');
  const textError = h('div', 'fieldError');
  const sendText = createDebounce(() => post({
    type: 'filters', text: { query: textQuery.value, regex: pressed(regexToggle), caseSensitive: pressed(caseToggle) },
  }), DEBOUNCE_MS);
  function toggleQueryOption(b) {
    setPressed(b, !pressed(b));
    sendText.call();
    sendText.flush();
  }

  for (const [input, d] of [[fromInput, sendTime], [toInput, sendTime], [sourceInput, sendSource], [textQuery, sendText]]) {
    input.addEventListener('input', () => d.call());
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') d.flush(); });
  }

  // One toggle per file of a merged view, built from the first state (the files of a session never change).
  let fileButtons = [];
  const fileField = field('files', [hidden.file]);
  fileField.hidden = true;
  function buildFileToggles(files) {
    fileButtons = files.map((p, i) => {
      const b = button(baseName(p), `Show the entries of ${p}`, () => {
        setPressed(b, !pressed(b));
        const on = [];
        fileButtons.forEach((x, j) => { if (pressed(x)) on.push(j); });
        // null = every file, so the filter goes away instead of listing all of them.
        post({ type: 'filters', files: on.length === fileButtons.length ? null : on });
      }, `toggle fileToggle ${fileClass(i)}`);
      return b;
    });
    fileField.querySelector('.line').replaceChildren(...fileButtons, hidden.file);
  }

  const filterRow = h('div', 'filters');
  filterRow.append(
    field('levels', [...LEVELS.map(l => levelButtons[l]), hidden.level]),
    field('time', [fromInput, h('span', 'dash', '–'), toInput, minutesInput, h('span', 'unit', 'min'),
      button('First', 'Show the first N minutes of the file', () => preset('first')),
      button('Last', 'Show the last N minutes of the file', () => preset('last')), hidden.time], timeErrors),
    field('source', [sourceInput, hidden.source]),
    field('text', [textQuery, regexToggle, caseToggle, hidden.text], textError),
    fileField,
  );

  // ---------- tool row ----------
  const timeSelect = h('select', 'timeMode');
  timeSelect.title = 'Time column';
  for (const [value, label] of TIME_MODES) {
    const o = h('option', null, label);
    o.value = value;
    timeSelect.append(o);
  }
  timeSelect.value = timeMode;
  timeSelect.addEventListener('change', () => {
    timeMode = timeSelect.value;
    save();
    render();
  });

  const groupBox = h('input');
  groupBox.type = 'checkbox';
  groupBox.addEventListener('change', () => post({ type: 'options', groupRepeats: groupBox.checked }));
  const groupLabel = h('label', 'group');
  groupLabel.title = 'Show consecutive repeats of an entry as one row';
  groupLabel.append(groupBox, h('span', null, 'Group repeats'));

  const nav = h('span', 'nav');
  nav.append(
    button('↑ Error', 'Previous error (Shift+F8)', () => runCommand('previousError')),
    button('↓ Error', 'Next error (F8)', () => runCommand('nextError')),
    button('◆', 'Toggle bookmark on the selected row (Ctrl+F2)', () => runCommand('toggleBookmark')),
    button('↑ Bookmark', 'Previous bookmark (Shift+F2)', () => runCommand('previousBookmark')),
    button('↓ Bookmark', 'Next bookmark (F2)', () => runCommand('nextBookmark')),
  );

  const status = h('span', 'status');
  const openRaw = button('Open as text', 'Open this file in the text editor', () => post({ type: 'openRaw' }), 'openRaw');
  const toolRow = h('div', 'tools');
  toolRow.append(timeSelect, groupLabel, nav, status, openRaw);

  const bar = h('div', 'bar');
  bar.append(filterRow, toolRow);

  const message = h('div', 'message');
  message.hidden = true;

  // ---------- table ----------
  const head = h('div', 'row head');
  for (const [cls, text] of [['mark', ''], ['time', 'Time'], ['file', 'File'], ['level', 'Level'], ['source', 'Source'], ['msg', 'Message']]) head.append(h('span', cls, text));

  const scroller = h('div', 'scroller');
  scroller.tabIndex = 0;
  const spacer = h('div', 'spacer');
  const rowsEl = h('div', 'rows');
  scroller.append(spacer, rowsEl);
  const table = h('div', 'table');
  table.append(head, scroller);

  // ---------- detail pane ----------
  const detailPane = h('div', 'detail');
  detailPane.hidden = true;
  const detailFields = h('div', 'detailFields');
  const detailHead = h('div', 'detailHead');
  detailHead.append(detailFields, button('×', 'Close the detail pane', closeDetail, 'close'));
  const detailNote = h('div', 'detailNote', 'Showing the first 1 MB, open as text for the rest');
  detailNote.hidden = true;
  const detailText = h('pre', 'detailText');
  detailPane.append(detailHead, detailNote, detailText);

  const app = document.getElementById('app');
  app.append(bar, message, table, detailPane);

  // ---------- state ----------
  let state = null;
  /** Rows of the last accepted reply: { pos, count, rows }. */
  let win = null;
  let transientError = '';
  /** Short navigation feedback in the status ("No next error"). */
  let note = '';
  /** Selected row position of the current revision, or null. */
  let selectedPos = null;
  /** Shown entry: { rev, pos, row, text, truncated, loading }; row may arrive after the text. */
  let detail = null;
  /** The last jump request, to word "No next error". */
  let lastJump = null;
  /** Filter inputs are filled from the state once; afterwards they hold what the user typed. */
  let inputsSynced = false;
  /** Request ids, revisions and the window in flight. */
  const requests = createRequests();

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'state': {
        state = m.state;
        if (requests.onState(state.revision)) {
          win = null;
          // Positions of another revision point at other rows.
          selectedPos = null;
          note = '';
          if (detail && detail.loading) {
            detail.loading = false;
            detail.text = 'The view changed before the entry was read; select the row again.';
            renderDetail();
          }
        }
        transientError = '';
        table.hidden = false;
        filterRow.hidden = false;
        syncControls();
        renderStatus();
        render();
        // Same revision (bookmark, live, progress): the rows may still have changed, so fetch them again.
        ensureWindow(true);
        break;
      }
      case 'rows':
        if (!requests.accept(m)) break;
        win = { pos: m.pos, count: m.rows.length, rows: m.rows };
        if (detail && detail.rev === m.rev) {
          const row = rowAt(detail.pos);
          if (row) {
            detail.row = row;
            renderDetail();
          }
        }
        render();
        ensureWindow(false);
        break;
      case 'detail':
        if (!detail || m.rev !== detail.rev || m.pos !== detail.pos) break;
        detail.text = m.text;
        detail.truncated = m.truncated;
        detail.loading = false;
        renderDetail();
        break;
      case 'jumped':
        onJumped(m);
        break;
      case 'command':
        runCommand(m.command);
        break;
      case 'filterError': {
        const [input, error] = m.field === 'from' ? [fromInput, fromError] : [toInput, toError];
        error.textContent = m.message;
        input.classList.toggle('invalid', !!m.message);
        break;
      }
      case 'stale':
        // The host sends the newer state right after; re-request now only if it is already here.
        requests.clear();
        if (m.rev !== requests.rev) ensureWindow(true);
        break;
      case 'error':
        // A failed rows request must not block the next one (the next scroll or resize asks again).
        requests.clear();
        if (detail && detail.loading) {
          detail.loading = false;
          renderDetail();
        }
        if (m.fatal) {
          state = null;
          win = null;
          table.hidden = true;
          filterRow.hidden = true;
          closeDetail();
          showMessage(m.message, 'error');
          status.textContent = '';
        } else {
          transientError = m.message;
          renderStatus();
        }
        break;
    }
  });

  function showMessage(text, kind) {
    message.textContent = text || '';
    message.className = `message ${kind || ''}`;
    message.hidden = !text;
  }

  /** Toggles, counts and hidden numbers always follow the state; the text inputs only on the first state. */
  function syncControls() {
    const f = state.filters;
    for (const l of LEVELS) {
      setPressed(levelButtons[l], f.levels.includes(l));
      levelButtons[l].textContent = `${l} ${(state.levelCounts[l] || 0).toLocaleString('en-US')}`;
    }
    for (const k of Object.keys(hidden)) hidden[k].textContent = hiddenLabel(state.hiddenBy[k] || 0);
    // The file column and the file toggles exist only in a merged view.
    const multi = state.files.length > 1;
    app.classList.toggle('multiFile', multi);
    fileField.hidden = !multi;
    if (multi && fileButtons.length !== state.files.length) buildFileToggles(state.files);
    fileButtons.forEach((b, i) => setPressed(b, !f.files || f.files.includes(i)));
    openRaw.title = multi ? 'Open the files in the text editor' : 'Open this file in the text editor';
    groupBox.checked = !!state.options.groupRepeats;
    textError.textContent = state.error || '';
    textQuery.classList.toggle('invalid', !!state.error);
    if (inputsSynced) return;
    inputsSynced = true;
    fromInput.value = typeof f.from === 'number' ? formatFilterTime(f.from) : '';
    toInput.value = typeof f.to === 'number' ? formatFilterTime(f.to) : '';
    sourceInput.value = f.source || '';
    textQuery.value = f.text ? f.text.query : '';
    setPressed(regexToggle, f.text && f.text.regex);
    setPressed(caseToggle, f.text && f.text.caseSensitive);
  }

  function renderStatus() {
    if (!state) return;
    const parts = [];
    if (state.scanning < 1) parts.push(`Scanning… ${Math.floor(state.scanning * 100)}%`);
    else {
      let s = `${state.matched.toLocaleString('en-US')} / ${state.total.toLocaleString('en-US')}`;
      if (state.rowCount !== state.matched) s += ` (${state.rowCount.toLocaleString('en-US')} rows)`;
      parts.push(s);
    }
    if (note) parts.push(note);
    status.textContent = parts.join('  ');
    if (transientError) showMessage(transientError, 'error');
    else if (state.warning) showMessage(state.warning, 'warning');
    else showMessage('', '');
  }

  // ---------- rows ----------
  const rowCount = () => (state ? state.rowCount : 0);
  const viewport = () => scroller.clientHeight;
  const currentRange = () => renderRange(scroller.scrollTop, rowCount(), viewport(), MARGIN);
  const rowAt = (pos) => (win && pos >= win.pos && pos < win.pos + win.count ? win.rows[pos - win.pos] : null);

  function ensureWindow(force) {
    if (!state) return;
    const w = nextWindow(currentRange(), rowCount(), win || undefined, requests.pending, force);
    if (!w) return;
    const q = requests.next(state.revision, w);
    post({ type: 'rows', rev: q.rev, pos: w.pos, count: w.count, id: q.id });
  }

  /**
   * Row elements are kept and refilled, never rebuilt per frame: a rebuilt node loses its hover and a click whose
   * mousedown and mouseup land on different nodes never fires. A slot shows row r.start + its index.
   */
  const slots = [];

  function makeSlot() {
    const s = { el: h('div', 'row'), mark: h('span', 'mark'), time: h('span', 'time'), file: h('span', 'file'),
      level: h('span', 'level'), source: h('span', 'source'), msg: h('span', 'msg'), pos: -1, row: undefined, sig: '' };
    s.mark.title = 'Toggle bookmark';
    s.el.append(s.mark, s.time, s.file, s.level, s.source, s.msg);
    rowsEl.append(s.el);
    return s;
  }

  function fillSlot(s, pos, row) {
    const selected = pos === selectedPos;
    const sig = `${timeMode}|${selected}|${state ? state.viewFirstTimeMs : ''}`;
    if (s.pos === pos && s.row === row && s.sig === sig) return;
    s.pos = pos;
    s.row = row;
    s.sig = sig;
    s.el.dataset.pos = String(pos);
    s.el.className = 'row' + (!row ? ' loading' : '') + (row && row.gap ? ' gap' : '') +
      (row && row.bookmarked ? ' bookmarked' : '') + (selected ? ' selected' : '');
    s.mark.textContent = row && row.bookmarked ? '◆' : '';
    if (!row) {
      for (const k of ['time', 'file', 'level', 'source']) {
        s[k].textContent = '';
        s[k].className = k;
      }
      s.msg.replaceChildren();
      return;
    }
    const t = rowTime(row, timeMode, state ? state.viewFirstTimeMs : undefined);
    s.time.textContent = t.text;
    s.time.className = t.warn ? 'time warn' : 'time';
    s.time.title = row.time;
    s.file.textContent = row.file;
    s.file.title = state ? state.files[row.fileIndex] || row.file : row.file;
    s.file.className = `file ${fileClass(row.fileIndex)}`;
    s.level.textContent = row.level === 'other' ? '' : row.level;
    s.level.className = `level level-${row.level}`;
    s.source.textContent = row.source;
    s.source.title = row.source;
    const parts = [h('span', 'text', row.message)];
    if (row.repeat > 1) parts.push(h('span', 'badge', `×${row.repeat}`));
    if (row.extraLines > 0) parts.push(h('span', 'badge', `+${row.extraLines} lines`));
    s.msg.replaceChildren(...parts);
  }

  function render() {
    const n = rowCount();
    const total = scrollHeight(n);
    spacer.style.height = `${total}px`;
    const r = currentRange();
    const count = Math.max(0, r.end - r.start);
    while (slots.length < count) slots.push(makeSlot());
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i >= count) {
        s.el.hidden = true;
        s.pos = -1;
        continue;
      }
      s.el.hidden = false;
      fillSlot(s, r.start + i, rowAt(r.start + i));
    }
    rowsEl.style.transform = `translateY(${r.top}px)`;
    // Never let the drawn rows grow the scroll area (proportional mode draws them at the viewport top).
    rowsEl.style.height = `${Math.max(0, Math.min(count * ROW_HEIGHT, total - r.top))}px`;
  }

  rowsEl.addEventListener('click', ev => {
    const target = ev.target instanceof Element ? ev.target : null;
    const el = target && target.closest('.row');
    if (!el || !state) return;
    const pos = Number(el.dataset.pos);
    if (!rowAt(pos)) return;
    if (target.closest('.mark')) return toggleBookmark(pos);
    // A drag that selected text is no row click.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
    select(pos, true);
  });

  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
      ensureWindow(false);
    });
  };
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);

  // ---------- selection, detail, navigation ----------
  function select(pos, openDetail) {
    selectedPos = pos;
    if (openDetail || !detailPane.hidden) showDetail(pos);
    render();
  }

  function showDetail(pos) {
    detail = { rev: state.revision, pos, row: rowAt(pos), text: '', truncated: false, loading: true };
    detailPane.hidden = false;
    post({ type: 'detail', rev: state.revision, pos });
    renderDetail();
  }

  function closeDetail() {
    detail = null;
    detailPane.hidden = true;
  }

  function renderDetail() {
    if (!detail) return;
    const r = detail.row;
    const fields = [];
    if (r) {
      fields.push(['Time', r.time], ['Level', r.level], ['Source', r.source], ['File', r.file]);
      if (r.seq !== undefined) fields.push(['Sequence', r.seq]);
      if (typeof r.deltaMs === 'number') fields.push(['Delta', formatDelta(r.deltaMs)]);
      if (r.repeat > 1) fields.push(['Group', `${r.repeat.toLocaleString('en-US')} entries (the text is the first one's)`]);
      if (r.extraLines > 0) fields.push(['Lines', `+${r.extraLines} lines`]);
    }
    detailFields.replaceChildren(...fields.map(([k, v]) => {
      const f = h('span', 'detailField');
      f.append(h('span', 'key', k), h('span', 'value', v));
      return f;
    }));
    detailNote.hidden = !detail.truncated;
    detailText.textContent = detail.loading ? 'Loading…' : detail.text;
    detailText.classList.toggle('loading', detail.loading);
  }

  function toggleBookmark(pos) {
    if (state) post({ type: 'bookmark', rev: state.revision, pos });
  }

  function jump(dir, what) {
    lastJump = { dir, what };
    note = '';
    post({ type: 'jump', rev: state.revision, from: navFrom(selectedPos, currentRange().first, dir), dir, what });
  }

  function onJumped(m) {
    if (!state || m.rev !== state.revision) return;
    if (m.pos < 0) {
      note = lastJump ? `No ${lastJump.dir > 0 ? 'next' : 'previous'} ${lastJump.what}` : '';
      renderStatus();
      return;
    }
    note = '';
    renderStatus();
    scroller.scrollTop = centerScrollTop(m.pos, rowCount(), viewport());
    select(m.pos, false);
    update();
  }

  function runCommand(command) {
    if (!state || rowCount() === 0) return;
    switch (command) {
      case 'nextError': return jump(1, 'error');
      case 'previousError': return jump(-1, 'error');
      case 'nextBookmark': return jump(1, 'bookmark');
      case 'previousBookmark': return jump(-1, 'bookmark');
      case 'toggleBookmark':
        if (selectedPos !== null) return toggleBookmark(selectedPos);
        note = 'Select a row to bookmark it';
        return renderStatus();
    }
  }

  post({ type: 'ready' });
})();
