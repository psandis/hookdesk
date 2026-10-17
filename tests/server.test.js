import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, redactHeaders } from '../src/server.js';
import { defaultConfigPath, loadConfig } from '../src/config.js';

// Expected defaults come from the data file, so changing config/default.json never breaks tests.
// Literal values below are either test inputs or security invariants.
const defaults = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
const prefix = defaults.capture.pathPrefix;
const placeholder = defaults.redaction.placeholder;
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
const uiHtmlPath = fileURLToPath(new URL('../src/ui.html', import.meta.url));

async function setup(overrides = { capture: { maxEvents: 2 } }) {
  const app = createApp({ config: loadConfig({ overrides }) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  return { ...app, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => app.server.close(resolve)) };
}

// fetch() cannot override the Host header, so raw requests go through node:http.
function rawRequest(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const addEvent = (app, fields) => {
  const event = { id: 'fixture', timestamp: new Date().toISOString(), method: 'POST', path: `${prefix}/fixture`, headers: {}, body: 'abc', bytes: 3, replayOf: null, ...fields };
  app.events.unshift(event);
  return event;
};

test('captures JSON webhook; list is summarized, detail is redacted', async () => {
  const app = await setup();
  try {
    const r = await fetch(`${app.origin}${prefix}/test?a=1`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: '{"hello":true}' });
    assert.equal(r.status, 200);
    const { events } = await (await fetch(`${app.origin}/api/events`)).json();
    assert.equal(events.length, 1);
    assert.equal(events[0].path, `${prefix}/test?a=1`);
    assert.equal(events[0].body, undefined);
    assert.equal(events[0].headers, undefined);
    const { event } = await (await fetch(`${app.origin}/api/events/${events[0].id}`)).json();
    assert.equal(event.headers.authorization, placeholder);
    assert.equal(event.body, '{"hello":true}');
  } finally { await app.close(); }
});

test('event detail returns 404 for unknown id', async () => {
  const app = await setup();
  try { assert.equal((await fetch(`${app.origin}/api/events/nope`)).status, 404); }
  finally { await app.close(); }
});

test('rejects cross origin mutation', async () => {
  const app = await setup();
  try {
    const r = await fetch(`${app.origin}${prefix}/test`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: 'x' });
    assert.equal(r.status, 403);
    assert.equal(app.events.length, 0);
  } finally { await app.close(); }
});

test('rejects foreign Host header (DNS rebinding)', async () => {
  const app = await setup();
  try {
    const r = await rawRequest(app.port, { path: '/api/events', headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
    const ok = await rawRequest(app.port, { path: '/api/events', headers: { host: `${defaults.server.allowedHostnames[0]}:${app.port}` } });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test('rejects payloads over capture.maxBodyBytes with 413', async () => {
  const app = await setup({ capture: { maxBodyBytes: 16 } });
  try {
    const r = await fetch(`${app.origin}${prefix}/big`, { method: 'POST', body: 'x'.repeat(100) });
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /16 bytes/);
    assert.equal(app.events.length, 0);
  } finally { await app.close(); }
});

test('replays locally without forwarding authorization', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/test`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: 'abc' });
    const first = app.events[0].id;
    const r = await fetch(`${app.origin}/api/events/${first}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events.length, 2);
    assert.equal(app.events[0].replayOf, first);
    assert.equal(app.events[0].headers.authorization, undefined);
    assert.equal(app.events[0].body, 'abc');
  } finally { await app.close(); }
});

// Invariant: fetch() rejects these headers, so the default replay config must strip them.
test('replays requests carrying Expect and Keep-Alive headers', async () => {
  const app = await setup();
  try {
    const source = addEvent(app, { headers: { expect: '100-continue', 'keep-alive': 'timeout=5', connection: 'keep-alive', 'content-type': 'text/plain' } });
    const r = await fetch(`${app.origin}/api/events/${source.id}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events[0].replayOf, source.id);
    assert.equal(app.events[0].headers['content-type'], 'text/plain');
  } finally { await app.close(); }
});

test('replays GET requests without a body', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/ping?x=1`);
    const r = await fetch(`${app.origin}/api/events/${app.events[0].id}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events[0].method, 'GET');
    assert.equal(app.events[0].path, `${prefix}/ping?x=1`);
  } finally { await app.close(); }
});

test('refuses to replay methods in replay.blockedMethods with 400', async () => {
  const app = await setup({ replay: { blockedMethods: ['PATCH'] } });
  try {
    const source = addEvent(app, { method: 'PATCH' });
    const r = await fetch(`${app.origin}/api/events/${source.id}/replay`, { method: 'POST' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /PATCH/);
  } finally { await app.close(); }
});

test('replay returns 404 for unknown id', async () => {
  const app = await setup();
  try { assert.equal((await fetch(`${app.origin}/api/events/nope/replay`, { method: 'POST' })).status, 404); }
  finally { await app.close(); }
});

test('keeps bounded event history', async () => {
  const app = await setup();
  try {
    for (let i = 0; i < 3; i++) await fetch(`${app.origin}${prefix}/${i}`, { method: 'POST', body: 'test' });
    assert.equal(app.events.length, 2);
  } finally { await app.close(); }
});

test('DELETE clears captured events', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/x`, { method: 'POST', body: 'x' });
    assert.equal((await fetch(`${app.origin}/api/events`, { method: 'DELETE' })).status, 200);
    assert.equal(app.events.length, 0);
  } finally { await app.close(); }
});

test('uses configured capture path prefix', async () => {
  const custom = `${prefix}-custom`;
  const app = await setup({ capture: { pathPrefix: custom } });
  try {
    assert.equal((await fetch(`${app.origin}${custom}/a`, { method: 'POST', body: 'x' })).status, 200);
    assert.equal((await fetch(`${app.origin}${prefix}/a`, { method: 'POST', body: 'x' })).status, 404);
  } finally { await app.close(); }
});

test('redacts authorization by default and honors custom lists', () => {
  assert.equal(redactHeaders({ authorization: 'Bearer x', 'content-type': 'text/plain' }).authorization, placeholder);
  assert.equal(redactHeaders({ 'x-custom': 'v' }, { sensitiveHeaders: ['x-custom'], placeholder: '***' })['x-custom'], '***');
});

test('exposes public config to the dashboard', async () => {
  const app = await setup();
  try {
    const config = await (await fetch(`${app.origin}/api/config`)).json();
    assert.equal(config.maxEvents, 2);
    assert.equal(config.captureBase, prefix);
    assert.equal(config.redactedPlaceholder, placeholder);
    assert.equal(config.pollIntervalMs, defaults.ui.pollIntervalMs);
    assert.equal(config.timelineWindowMs, defaults.ui.timelineWindowMs);
    assert.equal(config.defaultTheme, defaults.ui.defaultTheme);
  } finally { await app.close(); }
});

test('dashboard responds with HTML and CSP; HEAD works', async () => {
  const app = await setup();
  try {
    const r = await fetch(app.origin);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /style-src 'self'/);
    assert.match(await r.text(), /HookDesk Mini/);
    const head = await fetch(app.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { await app.close(); }
});

test('serves stylesheet; dashboard has no inline styles blocked by CSP', async () => {
  const app = await setup();
  try {
    const css = await fetch(`${app.origin}/ui.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const html = await readFile(uiHtmlPath, 'utf8');
    assert.doesNotMatch(html, /<style|style=/i);
    assert.match(html, /<link rel="stylesheet" href="\/ui.css">/);
  } finally { await app.close(); }
});

test('serves the logo as SVG', async () => {
  const app = await setup();
  try {
    const r = await fetch(`${app.origin}/logo.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await r.text(), /<svg/);
  } finally { await app.close(); }
});

test('starts when launched through a symlink (npm bin link)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hookdesk-'));
  const link = join(dir, 'hookdesk');
  await symlink(serverPath, link);
  const child = spawn(process.execPath, [link, '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('is running')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Exited with ${code}. Output: ${output}`)); });
    });
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
