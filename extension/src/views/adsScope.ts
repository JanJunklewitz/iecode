// ADS scope: a small live plot of the numeric watched variables. The extension owns the data (AdsHost buffer)
// and posts the visible window, thinned to the canvas width; the webview only draws and handles the controls.

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { AdsHost } from '../ads/host';
import { clampBufferSeconds, clampInterval, minMaxBuckets, niceTicks, spanOptions } from '../core/adswatch';
import { writeAdsSetting } from '../ads/settingsWrite';

const POST_MS = 100;
const MAX_WIDTH = 4000;

type Msg =
  | { type: 'view'; width: number; seconds: number; hidden: string[]; paused: boolean }
  | { type: 'sampling'; intervalMs?: number; bufferSeconds?: number };

let panel: vscode.WebviewPanel | undefined;

export function showAdsScope(ctx: vscode.ExtensionContext) {
  if (panel) { panel.reveal(); return; }
  const host = AdsHost.get(ctx);
  panel = vscode.window.createWebviewPanel('iecode.adsScope', 'IECode: ADS Scope', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = html(nonce, panel.webview.cspSource);
  // the host keeps running while the scope is open, also if the watch view is hidden
  const lease = host.use();
  const subs: vscode.Disposable[] = [];

  let view = { width: 600, seconds: 10, hidden: new Set<string>(), paused: false };
  let timer: NodeJS.Timeout | undefined;
  // right edge of the picture while paused; control changes re-post this window instead of jumping to the newest sample
  let frozenEnd: number | undefined;

  const post = () => {
    const p = panel;
    if (!p) return;
    const items = host.items().filter(i => i.numeric && !i.error);
    const syms = items.map(i => i.symbol);
    // the newest sample is the right edge, so the plot does not depend on the host clock matching ours
    let end = -Infinity;
    for (const s of syms) { const l = host.buffer.latest(s); if (l) end = Math.max(end, l.t); }
    if (view.paused && frozenEnd !== undefined) end = frozenEnd;
    const from = end - view.seconds * 1000;
    const s = host.state();
    p.webview.postMessage({
      type: 'data',
      spans: spanOptions(host.buffer.span()),
      sampling: host.sampling(),
      note: !s.connected && s.error ? `Disconnected: ${s.error}` : host.watched().length === 0 ? 'No variables watched.' : syms.length === 0 ? 'No numeric variables to plot.' : '',
      series: items.map(i => ({
        symbol: i.symbol,
        bool: i.type.toUpperCase() === 'BOOL',
        // times relative to the right edge, in seconds
        pts: view.hidden.has(i.symbol) || end === -Infinity ? [] : minMaxBuckets(host.buffer.series(i.symbol, from), view.width).map(pt => [(pt.t - end) / 1000, pt.y]),
      })),
    });
  };

  // at most 10 posts per second, however fast samples arrive
  const schedule = () => { if (!timer && !view.paused) timer = setTimeout(() => { timer = undefined; post(); }, POST_MS); };

  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    if (m.type === 'sampling') {
      // the host applies the setting live (config change event); the next post shows the new values
      try {
        if (m.intervalMs !== undefined) await writeAdsSetting('sampleIntervalMs', clampInterval(m.intervalMs));
        if (m.bufferSeconds !== undefined) await writeAdsSetting('bufferSeconds', clampBufferSeconds(m.bufferSeconds));
      } catch (e) {
        void vscode.window.showErrorMessage(`IECode: cannot save the scope setting: ${e instanceof Error ? e.message : e}`);
      }
      post();
      return;
    }
    if (m.type === 'view') {
      const was = view.paused;
      view = {
        width: Math.min(MAX_WIDTH, Math.max(50, Math.round(Number(m.width) || 600))),
        seconds: Math.max(1, Number(m.seconds) || 10),
        hidden: new Set(Array.isArray(m.hidden) ? m.hidden.map(String) : []),
        paused: !!m.paused,
      };
      if (view.paused && !was) {
        frozenEnd = undefined;
        for (const i of host.items()) { const l = host.buffer.latest(i.symbol); if (l && i.numeric && !i.error) frozenEnd = Math.max(frozenEnd ?? -Infinity, l.t); }
        // a post scheduled before the click must not redraw
        clearTimeout(timer); timer = undefined;
      }
    }
    // a control change is answered at once, also while paused
    post();
  }, undefined, subs);

  subs.push(host.onSamples(schedule), host.onItems(schedule), host.onState(schedule));
  panel.onDidDispose(() => {
    panel = undefined;
    clearTimeout(timer);
    subs.forEach(s => s.dispose());
    lease.dispose();
  });
}

export function html(nonce: string, csp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{height:100%}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;display:flex;flex-direction:column}
.top{display:flex;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;font:inherit}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 12px;cursor:pointer;font:inherit}
label{font-size:12px}
input[type=number]{width:64px}
#note{opacity:.8;font-size:12px}
#legend{display:flex;gap:14px;flex-wrap:wrap;padding:6px 14px}
#legend label{display:flex;align-items:center;gap:4px;white-space:nowrap}
#legend i{display:inline-block;width:10px;height:10px}
#wrap{flex:1;min-height:200px;position:relative}
canvas{position:absolute;left:0;top:0;width:100%;height:100%}
#tip{position:fixed;display:none;pointer-events:none;z-index:10;padding:4px 8px;font-size:12px;line-height:1.5;white-space:nowrap;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border))}
#tip i{display:inline-block;width:8px;height:8px;margin-right:6px}
#read{padding:6px 14px;font-family:var(--vscode-editor-font-family);font-size:12px;min-height:1.4em;border-top:1px solid var(--vscode-panel-border)}
</style></head><body>
<div class="top">
  <label>Time span <select id="span"></select><input id="spanc" type="number" hidden title="Seconds shown, up to the buffer length; Enter applies"></label>
  <label>Poll <select id="poll"></select><input id="pollc" type="number" hidden title="Read interval in ms (10 to 5000); Enter applies"></label>
  <label>Buffer <select id="buf"></select><input id="bufc" type="number" hidden title="Seconds of values kept (10 to 3600); Enter applies"></label>
  <button id="pause">Pause</button>
  <span id="note"></span>
</div>
<div id="legend"></div>
<div id="wrap"><canvas id="cv"></canvas></div>
<div id="read"></div>
<div id="tip"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const COLORS = ['#4e9de0', '#e5694e', '#4fb477', '#d9a93a', '#a678d6', '#3fb6c4', '#d86aa8', '#9aa34a'];
// hidden series and the span survive a reload of the webview
const saved = vscode.getState() || {};
let hidden = new Set(saved.hidden || []), seconds = saved.seconds || 10, paused = false;
// a span typed in by the user (not one of the offered ones)
const customSpans = new Set(saved.customSpans || []);
let data = { series: [], spans: [10] }, cursor = null;
// replies still owed to control changes; while paused only those redraw
let waiting = 0;
const cv = $('cv'), ctx = cv.getContext('2d');

function save() { vscode.setState({ hidden: [...hidden], seconds, customSpans: [...customSpans] }); }
function send() { waiting++; vscode.postMessage({ type: 'view', width: Math.round(cv.clientWidth) || 600, seconds, hidden: [...hidden], paused }); }
const color = i => COLORS[i % COLORS.length];
const fmt = v => Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(2) : String(Number(v.toPrecision(6)));

${niceTicks.toString()}

function legend() {
  $('legend').innerHTML = '';
  data.series.forEach((s, i) => {
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'checkbox'; c.checked = !hidden.has(s.symbol);
    c.onchange = () => { if (c.checked) hidden.delete(s.symbol); else hidden.add(s.symbol); save(); send(); draw(); };
    const sw = document.createElement('i'); sw.style.background = color(i);
    l.append(c, sw, document.createTextNode(s.symbol));
    $('legend').append(l);
  });
}

const secs = v => v >= 3600 && v % 3600 === 0 ? v / 3600 + ' h' : v >= 60 && v % 60 === 0 ? v / 60 + ' min' : v + ' s';
const POLLS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000], BUFFERS = [10, 30, 60, 120, 300, 600, 1800, 3600];

// A dropdown with fixed values plus "Custom...": that choice turns it into a number field until Enter (applies),
// Escape (cancels) or leaving the field (applies). Returns the function that fills it; it only rebuilds the list
// when the values changed, so an open dropdown is not closed by the steady stream of data.
function combo(id, min, max, fmt, apply) {
  const sel = $(id), num = $(id + 'c');
  let current = 0, key = '';
  const finish = ok => {
    if (num.hidden) return;
    const v = Number(num.value);
    num.hidden = true; sel.hidden = false;
    if (ok && num.value !== '' && isFinite(v)) apply(Math.min(max(), Math.max(min, Math.round(v))));
    else sel.value = String(current);
  };
  sel.onchange = () => {
    if (sel.value !== 'custom') { apply(Number(sel.value)); return; }
    sel.hidden = true; num.hidden = false; num.min = min; num.max = max(); num.value = current; num.focus(); num.select();
  };
  num.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  num.onblur = () => finish(true);
  return (values, now) => {
    current = now;
    const all = [...new Set([...values, now])].sort((a, b) => a - b);
    const k = all.join() + '|' + now;
    if (k === key) return;
    key = k;
    sel.innerHTML = all.map(v => '<option value="' + v + '">' + fmt(v) + '</option>').join('') + '<option value="custom">Custom...</option>';
    sel.value = String(now);
  };
}
const bufferCap = () => (data.sampling ? data.sampling.bufferSeconds : 3600);
const renderSpan = combo('span', 1, bufferCap, secs, v => {
  seconds = v; customSpans.clear();
  if (!data.spans.includes(v)) customSpans.add(v);
  save(); send(); spans();
});
const renderPoll = combo('poll', 10, () => 5000, v => v + ' ms', v => { data.sampling.intervalMs = v; vscode.postMessage({ type: 'sampling', intervalMs: v }); sampling(); });
const renderBuf = combo('buf', 10, () => 3600, secs, v => { data.sampling.bufferSeconds = v; vscode.postMessage({ type: 'sampling', bufferSeconds: v }); sampling(); spans(); });

function spans() {
  const opts = data.spans.length ? data.spans : [10];
  // offered spans depend on how much the buffer holds so far; a custom span stays, up to the buffer length
  for (const c of [...customSpans]) if (c > bufferCap()) customSpans.delete(c);
  const ok = [...opts, ...customSpans];
  if (!ok.includes(seconds)) { const keep = seconds; seconds = ok.filter(s => s <= keep).sort((a, b) => a - b).pop() || opts[0]; send(); }
  renderSpan(ok, seconds);
}

function draw() {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, L = 56, R = 10, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const css = getComputedStyle(document.body), fg = css.color;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ' + css.fontFamily; ctx.fillStyle = fg; ctx.strokeStyle = fg;
  if (pw < 20 || ph < 20) return;
  const vis = data.series.map((s, i) => ({ s, i })).filter(x => !hidden.has(x.s.symbol) && x.s.pts.length);
  let lo = Infinity, hi = -Infinity;
  for (const { s } of vis) for (const p of s.pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  if (!vis.length) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const X = t => L + (t + seconds) / seconds * pw, Y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
  geo = { Y };
  ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of niceTicks(lo, hi, 5)) {
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + pw, Y(v)); ctx.stroke();
    ctx.globalAlpha = 0.8; ctx.fillText(fmt(v), L - 6, Y(v));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of niceTicks(-seconds, 0, 5)) {
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), T + ph); ctx.stroke();
    ctx.globalAlpha = 0.8; ctx.fillText(t === 0 ? 'now' : t + ' s', X(t), T + ph + 5);
  }
  ctx.globalAlpha = 1;
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip(); ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  for (const { s, i } of vis) {
    ctx.strokeStyle = color(i); ctx.beginPath();
    s.pts.forEach((p, k) => {
      const x = X(p[0]), y = Y(p[1]);
      if (k === 0) ctx.moveTo(x, y);
      else if (s.bool) { ctx.lineTo(x, Y(s.pts[k - 1][1])); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.restore();
  if (cursor !== null && cursor >= L && cursor <= L + pw) {
    ctx.strokeStyle = fg; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(cursor, T); ctx.lineTo(cursor, T + ph); ctx.stroke(); ctx.globalAlpha = 1;
  }
  readout(L, pw);
}

// value of a series at time t: the last sample at or before t
function at(pts, t) {
  let a = 0, b = pts.length - 1, r = null;
  while (a <= b) { const m = (a + b) >> 1; if (pts[m][0] <= t) { r = pts[m]; a = m + 1; } else b = m - 1; }
  return r;
}

function readout(L, pw) {
  const tip = $('tip');
  if (cursor === null || cursor < L || cursor > L + pw) { $('read').textContent = ''; tip.style.display = 'none'; return; }
  const t = (cursor - L) / pw * seconds - seconds;
  const parts = [t.toFixed(1) + ' s'];
  // the tooltip belongs to the variable whose curve is nearest to the pointer, with a dot on that curve
  let near = null;
  data.series.forEach((s, i) => {
    if (hidden.has(s.symbol)) return;
    const p = at(s.pts, t);
    if (!p) return;
    parts.push(s.symbol + ' = ' + fmt(p[1]));
    const d = Math.abs(geo.Y(p[1]) - mouse.cy);
    if (!near || d < near.d) near = { s, i, v: p[1], d };
  });
  $('read').textContent = parts.join('   ');
  if (!near) { tip.style.display = 'none'; return; }
  ctx.fillStyle = color(near.i); ctx.beginPath(); ctx.arc(cursor, geo.Y(near.v), 4, 0, 2 * Math.PI); ctx.fill();
  tip.textContent = '';
  const head = document.createElement('div'), row = document.createElement('div'), sw = document.createElement('i');
  head.textContent = t.toFixed(1) + ' s';
  sw.style.background = color(near.i);
  row.append(sw, document.createTextNode(near.s.symbol + ' = ' + fmt(near.v)));
  tip.append(head, row);
  tip.style.display = 'block';
  // above the pointer; below it when there is no room, and kept inside the window
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const x = Math.max(4, Math.min(mouse.x + 14, window.innerWidth - w - 4));
  const y = mouse.y - h - 12 < 4 ? mouse.y + 18 : mouse.y - h - 12;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

// pointer in window coordinates (x, y) and in canvas coordinates (cy); geo.Y maps a value to a canvas y
let mouse = { x: 0, y: 0, cy: 0 }, geo = { Y: v => 0 };
cv.onmousemove = ev => { const r = cv.getBoundingClientRect(); cursor = ev.clientX - r.left; mouse = { x: ev.clientX, y: ev.clientY, cy: ev.clientY - r.top }; draw(); };
cv.onmouseleave = () => { cursor = null; draw(); };
// the dropdowns follow the settings (also when they are changed in the settings page)
function sampling() {
  const s = data.sampling;
  if (!s) return;
  renderPoll(POLLS, s.intervalMs);
  renderBuf(BUFFERS, s.bufferSeconds);
}
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; send(); };
new ResizeObserver(() => { send(); draw(); }).observe($('wrap'));
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type !== 'data') return;
  if (waiting > 0) waiting--;
  else if (paused) return;
  const same = m.series.length === data.series.length && m.series.every((s, i) => s.symbol === data.series[i].symbol);
  data = m;
  $('note').textContent = m.note;
  if (!same) legend();
  spans();
  sampling();
  draw();
});
send();
</script></body></html>`;
}
