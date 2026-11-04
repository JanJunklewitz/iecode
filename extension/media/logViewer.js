// Webview of the log viewer (see src/views/logViewer.ts): a virtual-scrolled table of the session's rows.
// Scroll mapping, request windows and stale-reply handling come from logScroll.js, loaded before this script
// (its top-level declarations are globals of the page). Log text goes into the DOM with textContent only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  /** Rows drawn above and below the visible ones. */
  const MARGIN = 5;

  /** Creates an element; text is set with textContent, never parsed as HTML. */
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  // ---------- layout ----------
  const app = document.getElementById('app');
  const bar = h('div', 'bar');
  const status = h('span', 'status');
  /** Filter controls go here (built from state.filters / state.options, so a reloaded window redraws them). */
  const filters = h('span', 'filters');
  const openRaw = h('button', 'openRaw', 'Open as text');
  openRaw.title = 'Open this file in the text editor';
  openRaw.addEventListener('click', () => vscode.postMessage({ type: 'openRaw' }));
  bar.append(filters, status, openRaw);

  const message = h('div', 'message');
  message.hidden = true;

  const head = h('div', 'row head');
  for (const [cls, text] of [['mark', ''], ['time', 'Time'], ['level', 'Level'], ['source', 'Source'], ['msg', 'Message']]) head.append(h('span', cls, text));

  const scroller = h('div', 'scroller');
  scroller.tabIndex = 0;
  const spacer = h('div', 'spacer');
  const rowsEl = h('div', 'rows');
  scroller.append(spacer, rowsEl);
  const table = h('div', 'table');
  table.append(head, scroller);
  app.append(bar, message, table);

  // ---------- state ----------
  let state = null;
  /** Rows of the last accepted reply: { pos, count, rows }. */
  let win = null;
  /** Window of the request in flight: { pos, count }. */
  let pending = null;
  let transientError = '';
  const requests = createRequests();

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'state': {
        state = m.state;
        if (requests.onState(state.revision)) win = null;
        pending = null;
        transientError = '';
        table.hidden = false;
        renderStatus();
        render();
        // Same revision (bookmark, live, progress): the rows may still have changed, so fetch them again.
        ensureWindow(true);
        break;
      }
      case 'rows':
        if (!requests.accept(m)) break;
        win = { pos: m.pos, count: m.rows.length, rows: m.rows };
        pending = null;
        render();
        ensureWindow(false);
        break;
      case 'stale':
        // The host sends the newer state right after; re-request now only if it is already here.
        pending = null;
        if (m.rev !== requests.rev) ensureWindow(true);
        break;
      case 'error':
        if (m.fatal) {
          state = null;
          win = null;
          table.hidden = true;
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

  function renderStatus() {
    if (!state) return;
    const parts = [];
    if (state.scanning < 1) parts.push(`Scanning… ${Math.floor(state.scanning * 100)}%`);
    else {
      let s = `${state.matched.toLocaleString()} / ${state.total.toLocaleString()}`;
      if (state.rowCount !== state.matched) s += ` (${state.rowCount.toLocaleString()} rows)`;
      parts.push(s);
    }
    status.textContent = parts.join('  ');
    const error = state.error || transientError;
    if (error) showMessage(error, 'error');
    else if (state.warning) showMessage(state.warning, 'warning');
    else showMessage('', '');
  }

  // ---------- table ----------
  const rowCount = () => (state ? state.rowCount : 0);
  const viewport = () => scroller.clientHeight;
  const currentRange = () => renderRange(scroller.scrollTop, rowCount(), viewport(), MARGIN);

  function ensureWindow(force) {
    const n = rowCount();
    if (!state || n === 0) return;
    const r = currentRange();
    if (!force) {
      if (!needsWindow(win, r.start, r.end, n)) return;
      if (pending && !needsWindow(pending, r.start, r.end, n)) return;
    }
    const w = windowFor(r.first, r.end - r.first, n);
    if (w.count === 0) return;
    const q = requests.next(state.revision);
    pending = w;
    vscode.postMessage({ type: 'rows', rev: q.rev, pos: w.pos, count: w.count, id: q.id });
  }

  function rowElement(pos, row) {
    const el = h('div', 'row');
    const mark = h('span', 'mark', row && row.bookmarked ? '◆' : '');
    mark.title = 'Toggle bookmark';
    mark.addEventListener('click', () => {
      if (state && row) vscode.postMessage({ type: 'bookmark', rev: state.revision, pos });
    });
    el.append(mark);
    if (!row) {
      el.classList.add('loading');
      el.append(h('span', 'time'), h('span', 'level'), h('span', 'source'), h('span', 'msg'));
      return el;
    }
    if (row.gap) el.classList.add('gap');
    if (row.bookmarked) el.classList.add('bookmarked');
    el.append(h('span', 'time', row.time), h('span', `level level-${row.level}`, row.level === 'other' ? '' : row.level), h('span', 'source', row.source));
    const msg = h('span', 'msg');
    if (row.repeat > 1) msg.append(h('span', 'badge', `${row.repeat}×`));
    msg.append(h('span', 'text', row.message));
    if (row.extraLines > 0) msg.append(h('span', 'badge more', `+${row.extraLines} lines`));
    el.append(msg);
    return el;
  }

  function render() {
    const n = rowCount();
    const total = scrollHeight(n);
    spacer.style.height = `${total}px`;
    const r = currentRange();
    const kids = [];
    for (let pos = r.start; pos < r.end; pos++) {
      const row = win && pos >= win.pos && pos < win.pos + win.count ? win.rows[pos - win.pos] : null;
      kids.push(rowElement(pos, row));
    }
    rowsEl.style.transform = `translateY(${r.top}px)`;
    // Never let the drawn rows grow the scroll area (proportional mode draws them at the viewport top).
    rowsEl.style.height = `${Math.max(0, Math.min((r.end - r.start) * ROW_HEIGHT, total - r.top))}px`;
    rowsEl.replaceChildren(...kids);
  }

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

  vscode.postMessage({ type: 'ready' });
})();
