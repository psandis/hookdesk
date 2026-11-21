const $ = id => document.getElementById(id);
// Every setting, route, and text comes from the config route (config/default.json, app.json, limits.json, messages.json).
const state = { config: null, events: [], mocks: [], mocksKey: '', selected: null, detail: null, listKey: '', online: true, seen: null, tab: null, flashes: new Map(), hover: null };
const ui = () => state.config.ui;
const t = () => state.config.messages;
const routes = () => state.config.routes;
const format = (template, values = {}) => template.replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);
const route = (name, id) => format(routes()[name], { id: encodeURIComponent(id) });
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
let toastTimer;
const showToast = message => { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ui().toastMs); };
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const copyText = (text, message) => navigator.clipboard.writeText(text).then(() => showToast(message)).catch(() => showToast(t().clipboardUnavailable));
async function getJson(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || format(t().httpStatus, { status: response.status }));
  return data;
}
const sendJson = (path, method, value) => getJson(path, { method, headers: { [state.config.headers.contentType]: state.config.contentTypes.json }, body: JSON.stringify(value) });

// Unit conversions (1024 bytes per KB, 60 seconds per minute) are arithmetic, not settings.
const bytesParts = n => n < 1024 ? [String(n), n === 1 ? t().byte : t().bytes] : n < 1048576 ? [(n / 1024).toFixed(1), t().kilobytes] : [(n / 1048576).toFixed(1), t().megabytes];
const fmtBytes = n => bytesParts(n).join(' ');
const exactBytes = n => format(t().exactBytes, { count: n.toLocaleString() });
const fmtAge = time => { const s = Math.max(0, Math.round((Date.now() - time) / 1000)); return s < 60 ? format(t().seconds, { value: s }) : s < 3600 ? format(t().minutes, { value: Math.floor(s / 60) }) : format(t().hours, { value: Math.floor(s / 3600) }); };
const fmtSpan = ms => ms >= 3600000 ? format(t().hours, { value: +(ms / 3600000).toFixed(1) }) : ms >= 60000 ? format(t().minutes, { value: +(ms / 60000).toFixed(1) }) : format(t().seconds, { value: Math.round(ms / 1000) });
const OTHER = 'other';
const methodKey = m => ui().methods.includes(m) ? m.toLowerCase() : OTHER;
const methodClass = m => `m m-${methodKey(m)}`;
const statusClass = s => s >= ui().errorStatusFrom ? 'num status-error' : 'num';

function setOnline(online) {
  if (online === state.online) return;
  state.online = online;
  $('live-label').textContent = online ? t().live : t().offline;
  $('live').classList.toggle('offline', !online);
  showToast(online ? t().reconnected : t().unreachable);
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
  setStat('rate', String(state.events.filter(e => now - e.t < ui().rateWindowMs).length));
  if (state.events.length) setStat('last', fmtAge(state.events[0].t), t().ago, false); else setStat('last', t().none, '', false);
  const total = state.events.reduce((sum, e) => sum + e.bytes, 0);
  setStat('bytes', ...bytesParts(total)); $('bytes').title = exactBytes(total);
}
const tickAges = () => { document.querySelectorAll('[data-t]').forEach(el => { el.textContent = fmtAge(Number(el.dataset.t)); }); renderStats(); };

const currentListKey = () => `${state.selected}|${state.events.map(x => x.id).join(',')}`;
function renderList() {
  state.listKey = currentListKey();
  const list = $('entries'); list.replaceChildren();
  if (!state.events.length) list.append(node('div', t().noRequests, 'empty'));
  // Only requests that arrived after the first render flash in the list and on the timeline.
  const firstRender = state.seen === null; state.seen ??= new Set();
  for (const event of state.events) {
    const isNew = !firstRender && !state.seen.has(event.id);
    if (isNew) state.flashes.set(event.id, performance.now());
    state.seen.add(event.id);
    const row = node('button', undefined, ['row', event.id === state.selected && 'selected', isNew && 'is-new'].filter(Boolean).join(' '));
    const path = node('span', event.path, 'path');
    if (event.replayOf) path.append(node('span', t().replayMark, 'replay-mark'));
    if (event.mockId) path.append(node('span', t().mockMark, 'mock-mark'));
    const age = node('span', fmtAge(event.t), 'num'); age.dataset.t = String(event.t);
    const size = node('span', fmtBytes(event.bytes), 'num'); size.title = exactBytes(event.bytes);
    row.append(node('span', event.method, methodClass(event.method)), path, node('span', String(event.status), statusClass(event.status)), size, age);
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
const keyValueTable = rows => {
  const table = node('div', undefined, 'headers');
  for (const [k, v, cls = 'hv'] of rows) { const row = node('div', undefined, 'header-row'); row.append(node('span', k, 'hk'), node('span', String(v), cls)); table.append(row); }
  return table;
};

function waitingState() {
  const box = node('div', undefined, 'waiting');
  const title = node('h2', t().waitingTitle, 'waiting-title'); title.append(node('span', undefined, 'cursor'));
  box.append(title, node('p', format(t().waitingText, { endpoint: state.endpoint }), 'waiting-text'));
  box.append(codeBlock(state.demoCommand, false));
  const actions = node('div', undefined, 'detail-actions');
  const copy = node('button', t().copyCurl, 'btn btn-primary'); copy.addEventListener('click', () => copyText(state.demoCommand, t().curlCopied));
  actions.append(copy); box.append(actions);
  return box;
}

// Detail tabs, in display order. Each has a label from messages.json, an optional count, and a panel.
const TABS = [
  { id: 'body', label: () => t().tabBody, count: e => fmtBytes(e.bytes), panel: e => {
    const contentType = String(e.headers[state.config.headers.contentType] || '');
    let text = e.body; let json = false;
    if (text) { try { text = JSON.stringify(JSON.parse(text), null, 2); json = true; } catch {} }
    return [text ? codeBlock(text, json) : node('div', t().emptyBody, 'note'), node('div', `${contentType || t().noContentType}${json ? t().formatted : ''}`, 'note')];
  } },
  { id: 'headers', label: () => t().tabHeaders, count: e => String(Object.keys(e.headers).length), panel: e =>
    [keyValueTable(Object.entries(e.headers).map(([k, v]) => [k, v, v === state.config.redactedPlaceholder ? 'hv redacted' : 'hv'])), node('div', t().redactedNote, 'note')] },
  { id: 'response', label: () => t().tabResponse, count: e => String(e.response.status), panel: e => {
    const { status, mockId, mockPath, delayMs } = e.response;
    return [keyValueTable([
      [t().responseStatus, status, status >= ui().errorStatusFrom ? 'hv redacted' : 'hv'],
      [t().responseAnsweredBy, mockId ? format(t().answeredByRule, { id: mockId, path: mockPath }) : t().answeredByDefault],
      [t().responseDelay, format(t().milliseconds, { value: delayMs })],
    ]), node('div', t().responseNote, 'note')];
  } },
  { id: 'curl', label: () => t().tabCurl, count: () => '', panel: e => [codeBlock(curlCommand(e), false), node('div', t().curlNote, 'note')] },
];

function renderDetail() {
  const detail = $('detail'); detail.replaceChildren();
  const event = state.detail;
  if (!event) { detail.append(state.events.length ? node('div', t().selectRequest, 'empty') : waitingState()); return; }
  const short = id => id.slice(0, ui().shortIdLength);
  const meta = node('div', undefined, 'detail-meta');
  const chip = (text, cls = '') => node('span', text, `chip ${cls}`);
  meta.append(chip(event.method, methodClass(event.method)), chip(new Date(event.timestamp).toLocaleString()), chip(fmtBytes(event.bytes)), chip(short(event.id)));
  if (event.replayOf) meta.append(chip(format(t().replayOf, { id: short(event.replayOf) }), 'chip-accent'));
  const actions = node('div', undefined, 'detail-actions');
  const replay = node('button', t().replayLocally, 'btn btn-primary'); replay.id = 'replay-btn';
  replay.addEventListener('click', replaySelected);
  const copy = node('button', t().copyAsCurl, 'btn'); copy.addEventListener('click', () => copyText(curlCommand(event), t().curlCopiedWarning));
  actions.append(replay, copy);

  state.tab ??= TABS[0].id;
  const tabs = node('div', undefined, 'tabs'); tabs.setAttribute('role', 'tablist');
  for (const tab of TABS) {
    const button = node('button', tab.label(), 'tab'); button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(state.tab === tab.id));
    const count = tab.count(event);
    if (count) button.append(node('span', count, 'count'));
    button.addEventListener('click', () => { state.tab = tab.id; renderDetail(); });
    tabs.append(button);
  }
  const panel = node('div', undefined, 'tab-panel');
  panel.append(...TABS.find(tab => tab.id === state.tab).panel(event));
  detail.append(node('h2', event.path, 'detail-path'), meta, actions, tabs, panel);
}

// Full headers and body are fetched only for the selected event; the list carries summaries.
async function loadDetail(id) {
  if (!id) { state.detail = null; renderDetail(); return; }
  try { const { event } = await getJson(route('event', id)); if (state.selected !== id) return; state.detail = event; }
  catch (error) { if (state.selected !== id) return; state.detail = null; showToast(format(t().cannotLoadRequest, { reason: error.message })); }
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
  try { const data = await getJson(route('replay', event.id), { method: state.config.methods.post }); showToast(format(t().replayed, { status: data.responseStatus })); await refresh(); }
  catch (e) { showToast(format(t().replayFailed, { reason: e.message })); }
  finally { const b = $('replay-btn'); if (b) b.disabled = false; }
}

// Mock rules: listed newest first, the first matching rule answers.
function renderMocks() {
  const key = JSON.stringify(state.mocks);
  if (key === state.mocksKey) return;
  state.mocksKey = key;
  const count = state.mocks.length;
  $('mocks-count').textContent = format(count === 1 ? t().rulesOne : t().rulesMany, { count });
  const list = $('mocks-list'); list.replaceChildren();
  if (!count) list.append(node('div', t().noRules, 'note'));
  for (const rule of state.mocks) {
    const row = node('div', undefined, 'mock-row');
    const remove = node('button', t().remove, 'btn btn-ghost btn-danger');
    remove.addEventListener('click', async () => {
      try { await getJson(route('mock', rule.id), { method: state.config.methods.delete }); await refreshMocks(); }
      catch (e) { showToast(format(t().cannotRemoveRule, { reason: e.message })); }
    });
    row.append(node('span', rule.method, rule.method === state.config.anyMethod ? `m m-${OTHER}` : methodClass(rule.method)), node('span', rule.path, 'path'), node('span', String(rule.status), statusClass(rule.status)), node('span', format(t().milliseconds, { value: rule.delayMs }), 'num'), node('span', rule.id, 'mock-id'), remove);
    list.append(row);
  }
}
async function refreshMocks() {
  try { state.mocks = (await getJson(routes().mocks)).rules; renderMocks(); } catch {}
}
async function addMock(e) {
  e.preventDefault();
  const f = e.target.elements;
  const contentType = state.config.headers.contentType;
  const rule = { method: f.method.value, path: f.path.value.trim(), status: Number(f.status.value), delayMs: Number(f.delayMs.value) };
  try { if (f.headers.value.trim()) rule.headers = JSON.parse(f.headers.value); }
  catch { showToast(t().headersNotJson); return; }
  if (f.body.value) {
    rule.body = f.body.value;
    // A body that parses as JSON is sent as JSON unless the headers already name a content type.
    const typed = Object.keys(rule.headers || {}).some(k => k.toLowerCase() === contentType);
    if (!typed) { try { JSON.parse(rule.body); rule.headers = { ...rule.headers, [contentType]: state.config.contentTypes.json }; } catch {} }
  }
  try {
    await sendJson(routes().mocks, state.config.methods.post, rule);
    showToast(t().ruleAdded);
    e.target.reset(); setupMockForm();
    await refreshMocks();
  } catch (err) { showToast(format(t().cannotAddRule, { reason: err.message })); }
}
function setupMockForm() {
  const f = $('mock-form').elements;
  const { mockRuleDefaults: defaults, statusRange } = state.config;
  f.path.value = state.config.captureBase;
  f.status.value = String(defaults.status); f.status.min = String(statusRange.min); f.status.max = String(statusRange.max);
  f.delayMs.value = String(defaults.delayMs); f.delayMs.min = String(state.config.minDelayMs); f.delayMs.max = String(state.config.maxDelayMs);
}

// Re-renders only what changed so scroll position and text selection survive polling.
async function refresh() {
  let data;
  try { data = await getJson(routes().events); } catch { setOnline(false); return; }
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
async function poll() { await Promise.all([refresh(), refreshMocks()]); setTimeout(poll, state.config.pollIntervalMs); }

// Timeline: one spike per request, height by payload size (log scale), color by method.
const scope = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1, colors: {}, lastDraw: 0 };
// The canvas cannot use CSS variables directly, so theme colors are re-read whenever the theme changes.
function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const name of ['line', 'line-strong', 'text', 'accent', 'raise', 'mono', ...[...ui().methods, OTHER].map(m => `m-${m.toLowerCase()}`)]) scope.colors[name] = css.getPropertyValue(`--${name}`).trim();
  scope.lastDraw = 0;
}
function setupScope() {
  const tl = ui().timeline;
  scope.canvas = $('scope'); scope.ctx = scope.canvas.getContext('2d');
  readColors();
  const resize = () => { const r = scope.canvas.getBoundingClientRect(); scope.dpr = window.devicePixelRatio || 1; scope.w = r.width; scope.h = r.height; scope.canvas.width = Math.round(r.width * scope.dpr); scope.canvas.height = Math.round(r.height * scope.dpr); scope.lastDraw = 0; };
  new ResizeObserver(resize).observe(scope.canvas); resize();
  const axis = $('axis'); const step = state.config.timelineWindowMs / tl.divisions;
  for (let i = tl.divisions; i >= 0; i--) axis.append(node('span', i ? `-${fmtSpan(step * i)}` : t().now));
  scope.canvas.addEventListener('mousemove', e => {
    const x = e.clientX - scope.canvas.getBoundingClientRect().left;
    let best = null, bestDist = tl.hoverRadiusPx;
    for (const ev of state.events) { const d = Math.abs(spikeX(ev.t) - x); if (d < bestDist) { best = ev; bestDist = d; } }
    state.hover = best; scope.canvas.style.cursor = best ? 'pointer' : 'crosshair'; scope.lastDraw = 0;
  });
  scope.canvas.addEventListener('mouseleave', () => { state.hover = null; scope.lastDraw = 0; });
  scope.canvas.addEventListener('click', () => { if (state.hover) select(state.hover.id); });
  requestAnimationFrame(drawScope);
}
const spikeX = time => (time - (Date.now() - state.config.timelineWindowMs)) / state.config.timelineWindowMs * scope.w;
function drawScope(now) {
  requestAnimationFrame(drawScope);
  const tl = ui().timeline; const flashMs = ui().flashMs;
  const animating = [...state.flashes.values()].some(start => now - start < flashMs);
  if (!animating && now - scope.lastDraw < tl.redrawMs) return;
  scope.lastDraw = now;
  for (const [id, start] of state.flashes) if (now - start > flashMs) state.flashes.delete(id);
  const { ctx, w, h, dpr, colors } = scope;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  // The 0.5 offsets put 1-pixel lines on pixel centers so they stay sharp.
  const base = h - 0.5;
  ctx.lineWidth = tl.lineWidth;
  ctx.strokeStyle = colors.line;
  for (let i = 0; i <= tl.divisions; i++) { const x = Math.round(i * (w - 1) / tl.divisions) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  ctx.setLineDash(tl.gridDash);
  for (let row = 1; row < tl.gridRows; row++) { const y = Math.round(h * row / tl.gridRows) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.strokeStyle = colors['line-strong']; ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();

  const maxLog = Math.log2(state.config.maxBodyBytes + 1);
  const emphasized = new Set([state.selected, state.hover?.id]);
  for (const ev of [...state.events].reverse()) {
    const x = spikeX(ev.t); if (x < -tl.hoverRadiusPx || x > w + tl.hoverRadiusPx) continue;
    const height = tl.minSpikePx + (h - tl.topPaddingPx) * Math.min(1, Math.log2(ev.bytes + 1) / maxLog);
    const color = colors[`m-${methodKey(ev.method)}`];
    const strong = emphasized.has(ev.id);
    const spikeWidth = strong ? tl.selectedSpikeWidthPx : tl.spikeWidthPx;
    ctx.globalAlpha = strong ? 1 : tl.idleAlpha; ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) - spikeWidth / 2, base - height, spikeWidth, height);
    ctx.beginPath(); ctx.arc(x, base - height, strong ? tl.selectedDotRadiusPx : tl.dotRadiusPx, 0, Math.PI * 2); ctx.fill();
    const start = state.flashes.get(ev.id);
    if (start !== undefined) {
      const p = (now - start) / flashMs;
      ctx.globalAlpha = Math.max(0, 1 - p); ctx.strokeStyle = color; ctx.lineWidth = tl.pulseLineWidth;
      ctx.beginPath(); ctx.arc(x, base - height, tl.selectedDotRadiusPx + p * tl.pulseGrowPx, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = tl.lineWidth;
    }
  }
  ctx.globalAlpha = 1;
  const sel = state.events.find(e => e.id === state.selected);
  if (sel) { const x = Math.round(spikeX(sel.t)) + 0.5; ctx.strokeStyle = colors.accent; ctx.globalAlpha = tl.selectionAlpha; ctx.setLineDash(tl.selectionDash); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
  if (state.hover) {
    const hv = state.hover;
    const label = format(t().hoverLabel, { method: hv.method, path: hv.path, status: hv.status, size: fmtBytes(hv.bytes), age: fmtAge(hv.t) });
    const pad = tl.labelPaddingPx; const lh = tl.labelHeightPx; const top = tl.labelTopPx;
    ctx.font = `${tl.labelFontPx}px ${colors.mono}`;
    const tw = Math.min(ctx.measureText(label).width + pad * 2, w);
    const lx = Math.min(Math.max(spikeX(hv.t) - tw / 2, 0), w - tw);
    ctx.fillStyle = colors.raise; ctx.strokeStyle = colors['line-strong'];
    ctx.fillRect(lx, top, tw, lh); ctx.strokeRect(lx + 0.5, top + 0.5, tw - 1, lh - 1);
    ctx.fillStyle = colors.text; ctx.textBaseline = 'middle'; ctx.fillText(label, lx + pad, top + lh / 2, tw - pad * 2);
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
  const keys = ui().keys;
  if (keys.next.includes(e.key)) { e.preventDefault(); moveSelection(1); }
  else if (keys.previous.includes(e.key)) { e.preventDefault(); moveSelection(-1); }
  else if (keys.replay.includes(e.key)) replaySelected();
  else if (keys.copyCurl.includes(e.key) && state.detail) copyText(curlCommand(state.detail), t().curlCopiedWarning);
}

// Theme: the first theme in config/limits.json ("auto") follows the OS. The viewer's choice is remembered in this browser only.
function applyTheme(choice, remember) {
  const themes = state.config.themes;
  if (!themes.includes(choice)) choice = themes[0];
  if (choice === themes[0]) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = choice;
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
  if (remember) { try { localStorage.setItem(ui().themeStorageKey, choice); } catch {} }
  readColors();
}
function setupTheme() {
  for (const theme of state.config.themes) { const b = node('button', t().themes[theme]); b.dataset.themeChoice = theme; $('themes').append(b); }
  let stored = null;
  try { stored = localStorage.getItem(ui().themeStorageKey); } catch {}
  applyTheme(stored ?? state.config.defaultTheme, false);
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice, true)));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColors);
}

function bindText(name, value) { document.querySelectorAll(`[data-bind="${name}"]`).forEach(el => { el.textContent = value; }); }

async function init() {
  try { state.config = await getJson(document.body.dataset.configUrl); }
  catch { $('live-label').textContent = document.body.dataset.offline; $('live').classList.add('offline'); setTimeout(init, Number(document.body.dataset.retryMs)); return; }
  state.online = true;
  state.endpoint = `${location.origin}${state.config.captureBase}`;
  state.demoCommand = format(state.config.exampleCommand, { url: `${state.endpoint}${state.config.examplePath}`, contentType: state.config.exampleContentType, body: state.config.exampleBody });
  document.title = state.config.name;
  bindText('host', state.config.host);
  bindText('limit', String(state.config.maxEvents));
  bindText('window', fmtSpan(state.config.timelineWindowMs));
  bindText('version', state.config.version);
  bindText('rate-window', fmtSpan(ui().rateWindowMs));
  bindText('prefix-suffix', state.config.prefixSuffix);
  document.querySelectorAll('[data-keys]').forEach(el => { for (const action of el.dataset.keys.split(' ')) el.append(node('kbd', ui().keys[action][0])); });
  for (const method of ui().methods) $('legend').append(node('span', method, methodClass(method)));
  $('legend').append(node('span', t().otherMethods, `m m-${OTHER}`));
  for (const method of ui().mockMethods) $('mock-form').elements.method.append(node('option', method));
  setupMockForm();
  $('command').textContent = state.demoCommand;
  $('copy').addEventListener('click', () => copyText(state.endpoint, t().endpointCopied));
  $('copy-cmd').addEventListener('click', () => copyText(state.demoCommand, t().curlCopied));
  $('refresh').addEventListener('click', refresh);
  $('clear').addEventListener('click', async () => {
    if (!confirm(t().confirmClear)) return;
    try { await getJson(routes().events, { method: state.config.methods.delete }); } catch (e) { showToast(format(t().clearFailed, { reason: e.message })); return; }
    state.selected = null; state.detail = null; await refresh(); renderDetail();
  });
  $('mock-form').addEventListener('submit', addMock);
  $('mocks-clear').addEventListener('click', async () => {
    if (!confirm(t().confirmRemoveRules)) return;
    try { await getJson(routes().mocks, { method: state.config.methods.delete }); await refreshMocks(); } catch (e) { showToast(format(t().cannotRemoveRules, { reason: e.message })); }
  });
  document.addEventListener('keydown', onKey);
  setupScope();
  setupTheme();
  // The list renders on the first poll, so requests already in memory at page load don't flash as new.
  renderDetail(); poll();
  setInterval(tickAges, ui().ageTickMs);
}
init();
