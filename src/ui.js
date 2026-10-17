const $ = id => document.getElementById(id);
// Settings come from GET /api/config, which mirrors config/default.json plus any overrides.
const state = { config: null, events: [], selected: null, detail: null, listKey: '', online: true, seen: null, tab: 'body', flashes: new Map(), hover: null };
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
let toastTimer;
const showToast = message => { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); };
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const copyText = (text, message) => navigator.clipboard.writeText(text).then(() => showToast(message)).catch(() => showToast('Clipboard unavailable'));
async function getJson(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const bytesParts = n => n < 1024 ? [String(n), n === 1 ? 'byte' : 'bytes'] : n < 1048576 ? [(n / 1024).toFixed(1), 'KB'] : [(n / 1048576).toFixed(1), 'MB'];
const fmtBytes = n => bytesParts(n).join(' ');
const exactBytes = n => `${n.toLocaleString()} bytes`;
const fmtAge = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const fmtSpan = ms => ms >= 3600000 ? `${+(ms / 3600000).toFixed(1)}h` : ms >= 60000 ? `${+(ms / 60000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const methodClass = m => `m m-${METHODS.includes(m) ? m.toLowerCase() : 'other'}`;

function setOnline(online) {
  if (online === state.online) return;
  state.online = online;
  $('live-label').textContent = online ? 'Live' : 'Offline';
  $('live').classList.toggle('offline', !online);
  showToast(online ? 'Reconnected to local server' : 'Cannot reach local server');
}

// The number is shown large and the unit small, so values like "119 bytes" fit the stat box.
function setStat(id, value, unit = '', bump = true) {
  const el = $(id); const text = `${value} ${unit}`;
  if (el.dataset.v === text) return;
  el.dataset.v = text;
  el.replaceChildren(value);
  if (unit) el.append(node('span', unit, 'unit'));
  if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
function renderStats() {
  const now = Date.now();
  setStat('count', String(state.events.length));
  setStat('rate', String(state.events.filter(e => now - e.t < 60000).length));
  if (state.events.length) setStat('last', fmtAge(state.events[0].t), 'ago', false); else setStat('last', 'none', '', false);
  const total = state.events.reduce((sum, e) => sum + e.bytes, 0);
  setStat('bytes', ...bytesParts(total)); $('bytes').title = exactBytes(total);
}
const tickAges = () => { document.querySelectorAll('[data-t]').forEach(el => { el.textContent = fmtAge(Number(el.dataset.t)); }); renderStats(); };

const currentListKey = () => `${state.selected}|${state.events.map(x => x.id).join(',')}`;
function renderList() {
  state.listKey = currentListKey();
  const list = $('entries'); list.replaceChildren();
  if (!state.events.length) list.append(node('div', 'No requests yet.', 'empty'));
  // Only requests that arrived after the first render flash in the list and on the timeline.
  const firstRender = state.seen === null; state.seen ??= new Set();
  for (const event of state.events) {
    const isNew = !firstRender && !state.seen.has(event.id);
    if (isNew) state.flashes.set(event.id, performance.now());
    state.seen.add(event.id);
    const row = node('button', undefined, ['row', event.id === state.selected && 'selected', isNew && 'is-new'].filter(Boolean).join(' '));
    const path = node('span', event.path, 'path');
    if (event.replayOf) path.append(node('span', 'replay', 'replay-mark'));
    const age = node('span', fmtAge(event.t), 'num'); age.dataset.t = String(event.t);
    const size = node('span', fmtBytes(event.bytes), 'num'); size.title = exactBytes(event.bytes);
    row.append(node('span', event.method, methodClass(event.method)), path, size, age);
    row.addEventListener('click', () => select(event.id));
    list.append(row);
    if (event.id === state.selected) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
  }
}

function curlCommand(event) {
  const excluded = new Set(state.config.curlExcludedHeaders);
  const headers = Object.entries(event.headers).filter(([k, v]) => !excluded.has(k.toLowerCase()) && v !== state.config.redactedPlaceholder);
  return ['curl', '-X', quote(event.method), ...headers.flatMap(([k, v]) => ['-H', quote(`${k}: ${v}`)]), ...(event.body ? ['--data-raw', quote(event.body)] : []), quote(location.origin + event.path)].join(' ');
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;
function highlightJsonLine(line) {
  const frag = document.createDocumentFragment(); let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) frag.append(line.slice(last, m.index));
    if (m[1]) { frag.append(node('span', m[1], m[2] ? 't-key' : 't-str')); if (m[2]) frag.append(node('span', m[2], 't-punc')); }
    else if (m[3]) frag.append(node('span', m[3], 't-lit'));
    else if (m[4]) frag.append(node('span', m[4], 't-num'));
    else frag.append(node('span', m[5], 't-punc'));
    last = m.index + m[0].length;
  }
  if (last < line.length) frag.append(line.slice(last));
  return frag;
}
function codeBlock(text, highlight) {
  const block = node('div', undefined, 'code');
  for (const line of text.split('\n')) { const row = node('div', undefined, 'code-line'); const content = node('span'); content.append(highlight ? highlightJsonLine(line) : line); row.append(content); block.append(row); }
  return block;
}

function waitingState() {
  const box = node('div', undefined, 'waiting');
  const title = node('h2', 'Waiting for the first request', 'waiting-title'); title.append(node('span', undefined, 'cursor'));
  box.append(title, node('p', `Send any HTTP method to ${state.endpoint}/anything. It shows up here and on the timeline the moment it lands.`, 'waiting-text'));
  box.append(codeBlock(state.demoCommand, false));
  const actions = node('div', undefined, 'detail-actions');
  const copy = node('button', 'Copy curl', 'btn btn-primary'); copy.addEventListener('click', () => copyText(state.demoCommand, 'curl copied'));
  actions.append(copy); box.append(actions);
  return box;
}

function renderDetail() {
  const detail = $('detail'); detail.replaceChildren();
  const event = state.detail;
  if (!event) { detail.append(state.events.length ? node('div', 'Select a request.', 'empty') : waitingState()); return; }
  const meta = node('div', undefined, 'detail-meta');
  const chip = (text, cls = '') => node('span', text, `chip ${cls}`);
  meta.append(chip(event.method, methodClass(event.method)), chip(new Date(event.timestamp).toLocaleString()), chip(fmtBytes(event.bytes)), chip(event.id.slice(0, 8)));
  if (event.replayOf) meta.append(chip(`replay of ${event.replayOf.slice(0, 8)}`, 'chip-accent'));
  const actions = node('div', undefined, 'detail-actions');
  const replay = node('button', 'Replay locally', 'btn btn-primary'); replay.id = 'replay-btn';
  replay.addEventListener('click', replaySelected);
  const copy = node('button', 'Copy as curl', 'btn'); copy.addEventListener('click', () => copyText(curlCommand(event), 'curl copied. Check for secrets before sharing.'));
  actions.append(replay, copy);

  const headerCount = Object.keys(event.headers).length;
  const tabs = node('div', undefined, 'tabs'); tabs.setAttribute('role', 'tablist');
  for (const [id, label, count] of [['body', 'Body', fmtBytes(event.bytes)], ['headers', 'Headers', String(headerCount)], ['curl', 'cURL']]) {
    const tab = node('button', label, 'tab'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.tab === id));
    if (count) tab.append(node('span', count, 'count'));
    tab.addEventListener('click', () => { state.tab = id; renderDetail(); });
    tabs.append(tab);
  }
  const panel = node('div', undefined, 'tab-panel');
  if (state.tab === 'body') {
    const contentType = String(event.headers['content-type'] || '');
    let text = event.body; let json = false;
    if (text) { try { text = JSON.stringify(JSON.parse(text), null, 2); json = true; } catch {} }
    panel.append(text ? codeBlock(text, json) : node('div', 'Empty body.', 'note'), node('div', `${contentType || 'no content-type'}${json ? ' / formatted' : ''}`, 'note'));
  } else if (state.tab === 'headers') {
    const table = node('div', undefined, 'headers');
    for (const [k, v] of Object.entries(event.headers)) { const row = node('div', undefined, 'header-row'); row.append(node('span', k, 'hk'), node('span', String(v), v === state.config.redactedPlaceholder ? 'hv redacted' : 'hv')); table.append(row); }
    panel.append(table, node('div', 'Sensitive header values are redacted.', 'note'));
  } else {
    panel.append(codeBlock(curlCommand(event), false), node('div', 'Redacted headers are left out. The body may still contain secrets.', 'note'));
  }
  detail.append(node('h2', event.path, 'detail-path'), meta, actions, tabs, panel);
}

// Full headers and body are fetched only for the selected event; the list carries summaries.
async function loadDetail(id) {
  if (!id) { state.detail = null; renderDetail(); return; }
  try { const { event } = await getJson(`/api/events/${encodeURIComponent(id)}`); if (state.selected !== id) return; state.detail = event; }
  catch (error) { if (state.selected !== id) return; state.detail = null; showToast(`Cannot load request: ${error.message}`); }
  renderDetail();
}
function select(id) {
  if (!id || id === state.selected) return;
  state.selected = id;
  renderList();
  return loadDetail(id);
}
async function replaySelected() {
  const event = state.detail; if (!event) return;
  const button = $('replay-btn'); if (button) button.disabled = true;
  try { const data = await getJson(`/api/events/${encodeURIComponent(event.id)}/replay`, { method: 'POST' }); showToast(`Replayed locally / HTTP ${data.responseStatus}`); await refresh(); }
  catch (e) { showToast(`Replay failed: ${e.message}`); }
  finally { const b = $('replay-btn'); if (b) b.disabled = false; }
}

// Re-renders only what changed so scroll position and text selection survive polling.
async function refresh() {
  let data;
  try { data = await getJson('/api/events'); } catch { setOnline(false); return; }
  setOnline(true);
  state.events = data.events.map(e => ({ ...e, t: Date.parse(e.timestamp) }));
  let target = state.selected;
  if (target && !state.events.some(x => x.id === target)) target = null;
  if (!target && state.events.length) target = state.events[0].id;
  const selectionChanged = target !== state.selected;
  state.selected = target;
  if (currentListKey() !== state.listKey) renderList();
  renderStats();
  if (selectionChanged) await loadDetail(target);
}
async function poll() { await refresh(); setTimeout(poll, state.config.pollIntervalMs); }

// Timeline: one spike per request, height by payload size (log scale), color by method.
const scope = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1, colors: {}, lastDraw: 0 };
// The canvas cannot use CSS variables directly, so theme colors are re-read whenever the theme changes.
function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const name of ['line', 'line-strong', 'faint', 'dim', 'text', 'accent', 'raise', 'm-get', 'm-post', 'm-put', 'm-patch', 'm-delete', 'm-other']) scope.colors[name] = css.getPropertyValue(`--${name}`).trim();
  scope.lastDraw = 0;
}
function setupScope() {
  scope.canvas = $('scope'); scope.ctx = scope.canvas.getContext('2d');
  readColors();
  const resize = () => { const r = scope.canvas.getBoundingClientRect(); scope.dpr = window.devicePixelRatio || 1; scope.w = r.width; scope.h = r.height; scope.canvas.width = Math.round(r.width * scope.dpr); scope.canvas.height = Math.round(r.height * scope.dpr); scope.lastDraw = 0; };
  new ResizeObserver(resize).observe(scope.canvas); resize();
  const axis = $('axis'); const step = state.config.timelineWindowMs / 5;
  for (let i = 5; i >= 0; i--) axis.append(node('span', i ? `-${fmtSpan(step * i)}` : 'now'));
  scope.canvas.addEventListener('mousemove', e => {
    const x = e.clientX - scope.canvas.getBoundingClientRect().left;
    let best = null, bestDist = 8;
    for (const ev of state.events) { const d = Math.abs(spikeX(ev.t) - x); if (d < bestDist) { best = ev; bestDist = d; } }
    state.hover = best; scope.canvas.style.cursor = best ? 'pointer' : 'crosshair'; scope.lastDraw = 0;
  });
  scope.canvas.addEventListener('mouseleave', () => { state.hover = null; scope.lastDraw = 0; });
  scope.canvas.addEventListener('click', () => { if (state.hover) select(state.hover.id); });
  requestAnimationFrame(drawScope);
}
const spikeX = t => (t - (Date.now() - state.config.timelineWindowMs)) / state.config.timelineWindowMs * scope.w;
function drawScope(now) {
  requestAnimationFrame(drawScope);
  const animating = [...state.flashes.values()].some(start => now - start < 1400);
  if (!animating && now - scope.lastDraw < 250) return;
  scope.lastDraw = now;
  for (const [id, start] of state.flashes) if (now - start > 1400) state.flashes.delete(id);
  const { ctx, w, h, dpr, colors } = scope;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const base = h - 0.5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.line;
  for (let i = 0; i <= 5; i++) { const x = Math.round(i * (w - 1) / 5) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  ctx.setLineDash([2, 4]);
  for (const y of [h * 0.33, h * 0.66]) { ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.strokeStyle = colors['line-strong']; ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();

  const maxLog = Math.log2(state.config.maxBodyBytes + 1);
  const emphasized = new Set([state.selected, state.hover?.id]);
  for (const ev of [...state.events].reverse()) {
    const x = spikeX(ev.t); if (x < -4 || x > w + 4) continue;
    const height = 8 + (h - 22) * Math.min(1, Math.log2(ev.bytes + 1) / maxLog);
    const color = colors[`m-${METHODS.includes(ev.method) ? ev.method.toLowerCase() : 'other'}`];
    const strong = emphasized.has(ev.id);
    ctx.globalAlpha = strong ? 1 : 0.7; ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) - (strong ? 1 : 0.5), base - height, strong ? 2 : 1, height);
    ctx.beginPath(); ctx.arc(x, base - height, strong ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
    const start = state.flashes.get(ev.id);
    if (start !== undefined) {
      const p = (now - start) / 1400;
      ctx.globalAlpha = Math.max(0, 1 - p); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, base - height, 3 + p * 18, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
  }
  ctx.globalAlpha = 1;
  const sel = state.events.find(e => e.id === state.selected);
  if (sel) { const x = Math.round(spikeX(sel.t)) + 0.5; ctx.strokeStyle = colors.accent; ctx.globalAlpha = 0.35; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
  if (state.hover) {
    const label = `${state.hover.method} ${state.hover.path}  ${fmtBytes(state.hover.bytes)}  ${fmtAge(state.hover.t)} ago`;
    ctx.font = '11px "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
    const tw = Math.min(ctx.measureText(label).width + 16, w);
    const lx = Math.min(Math.max(spikeX(state.hover.t) - tw / 2, 0), w - tw);
    ctx.fillStyle = colors.raise; ctx.strokeStyle = colors['line-strong'];
    ctx.fillRect(lx, 2, tw, 22); ctx.strokeRect(lx + 0.5, 2.5, tw - 1, 21);
    ctx.fillStyle = colors.text; ctx.fillText(label, lx + 8, 17, tw - 16);
  }
}

function moveSelection(step) {
  if (!state.events.length) return;
  const index = state.events.findIndex(e => e.id === state.selected);
  const next = state.events[Math.min(state.events.length - 1, Math.max(0, (index === -1 ? 0 : index + step)))];
  select(next.id);
}
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'r') replaySelected();
  else if (e.key === 'c' && state.detail) copyText(curlCommand(state.detail), 'curl copied. Check for secrets before sharing.');
}

// Theme: "auto" follows the OS. The viewer's choice is remembered in this browser only.
const THEMES = ['auto', 'light', 'dark'];
const THEME_KEY = 'hookdesk-theme';
function applyTheme(choice, remember) {
  if (!THEMES.includes(choice)) choice = 'auto';
  if (choice === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = choice;
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
  if (remember) { try { localStorage.setItem(THEME_KEY, choice); } catch {} }
  readColors();
}
function setupTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  applyTheme(stored ?? state.config.defaultTheme, false);
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice, true)));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColors);
}

function renderCommand() {
  const el = $('command'); el.replaceChildren();
  el.append('curl -X POST ', node('span', `${state.endpoint}/demo`, 'url'), ` -H 'Content-Type: application/json' -d '{"hello":"world"}'`);
}

async function init() {
  try { state.config = await getJson('/api/config'); }
  catch { setOnline(false); setTimeout(init, 3000); return; }
  setOnline(true);
  state.endpoint = `${location.origin}${state.config.captureBase}`;
  state.demoCommand = `curl -X POST ${state.endpoint}/demo -H 'Content-Type: application/json' -d '{"hello":"world"}'`;
  document.querySelectorAll('[data-bind="host"]').forEach(el => { el.textContent = state.config.host; });
  document.querySelectorAll('[data-bind="limit"]').forEach(el => { el.textContent = String(state.config.maxEvents); });
  document.querySelectorAll('[data-bind="window"]').forEach(el => { el.textContent = fmtSpan(state.config.timelineWindowMs); });
  renderCommand();
  $('copy').addEventListener('click', () => copyText(state.endpoint, 'Endpoint copied'));
  $('copy-cmd').addEventListener('click', () => copyText(state.demoCommand, 'curl copied'));
  $('refresh').addEventListener('click', refresh);
  $('clear').addEventListener('click', async () => {
    if (!confirm('Clear all captured requests?')) return;
    try { await getJson('/api/events', { method: 'DELETE' }); } catch (e) { showToast(`Clear failed: ${e.message}`); return; }
    state.selected = null; state.detail = null; await refresh(); renderDetail();
  });
  document.addEventListener('keydown', onKey);
  setupScope();
  setupTheme();
  // The list renders on the first poll, so requests already in memory at page load don't flash as new.
  renderDetail(); poll();
  setInterval(tickAges, 1000);
}
init();
