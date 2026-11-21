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
import { defaultConfigPath, loadConfig } from '../src/loader/settings.js';

// Expected values come from the JSON files, so changing config never breaks tests.
// Literal values below are either test inputs or security invariants.
const defaults = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
const appJson = JSON.parse(readFileSync(new URL('../config/app.json', import.meta.url), 'utf8'));
const prefix = defaults.capture.pathPrefix;
const placeholder = defaults.redaction.placeholder;
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const uiHtmlPath = fileURLToPath(new URL('../src/ui/index.html', import.meta.url));

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
  const event = { id: 'fixture', timestamp: new Date().toISOString(), method: 'POST', path: `${prefix}/fixture`, pathname: `${prefix}/fixture`, headers: {}, body: 'abc', bytes: 3, replayOf: null, response: { status: 200, mockId: null, mockPath: null, delayMs: 0 }, ...fields };
  app.events.add(event);
  return event;
};
const postJson = (url, value) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('captures JSON webhook; list is summarized, detail is redacted', async () => {
  const app = await setup();
  try {
    const r = await fetch(`${app.origin}${prefix}/test?a=1`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: '{"hello":true}' });
    assert.equal(r.status, appJson.defaultResponse.status);
    const reply = await r.json();
    assert.equal(r.headers.get(appJson.headers.eventId), reply.id);
    const { events } = await (await fetch(`${app.origin}/api/events`)).json();
    assert.equal(events.length, 1);
    assert.equal(events[0].path, `${prefix}/test?a=1`);
    assert.equal(events[0].status, appJson.defaultResponse.status);
    assert.equal(events[0].body, undefined);
    assert.equal(events[0].headers, undefined);
    const { event } = await (await fetch(`${app.origin}/api/events/${events[0].id}`)).json();
    assert.equal(event.headers.authorization, placeholder);
    assert.equal(event.body, '{"hello":true}');
    assert.equal(event.pathname, undefined);
    assert.deepEqual(event.response, { status: appJson.defaultResponse.status, mockId: null, mockPath: null, delayMs: 0 });
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
    assert.equal(app.events.items.length, 0);
    const m = await fetch(`${app.origin}/api/mocks`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ path: prefix }) });
    assert.equal(m.status, 403);
    assert.equal(app.mocks.list.length, 0);
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
    assert.equal(app.events.items.length, 0);
  } finally { await app.close(); }
});

test('replays locally without forwarding authorization', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/test`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: 'abc' });
    const first = app.events.items[0].id;
    const r = await fetch(`${app.origin}/api/events/${first}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events.items.length, 2);
    assert.equal(app.events.items[0].replayOf, first);
    assert.equal(app.events.items[0].headers.authorization, undefined);
    assert.equal(app.events.items[0].body, 'abc');
  } finally { await app.close(); }
});

// Invariant: fetch() rejects these headers, so the default replay config must strip them.
test('replays requests carrying Expect and Keep-Alive headers', async () => {
  const app = await setup();
  try {
    const source = addEvent(app, { headers: { expect: '100-continue', 'keep-alive': 'timeout=5', connection: 'keep-alive', 'content-type': 'text/plain' } });
    const r = await fetch(`${app.origin}/api/events/${source.id}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events.items[0].replayOf, source.id);
    assert.equal(app.events.items[0].headers['content-type'], 'text/plain');
  } finally { await app.close(); }
});

test('replays GET requests without a body', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/ping?x=1`);
    const r = await fetch(`${app.origin}/api/events/${app.events.items[0].id}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events.items[0].method, 'GET');
    assert.equal(app.events.items[0].path, `${prefix}/ping?x=1`);
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
    assert.equal(app.events.items.length, 2);
  } finally { await app.close(); }
});

test('DELETE clears captured events', async () => {
  const app = await setup();
  try {
    await fetch(`${app.origin}${prefix}/x`, { method: 'POST', body: 'x' });
    assert.equal((await fetch(`${app.origin}/api/events`, { method: 'DELETE' })).status, 200);
    assert.equal(app.events.items.length, 0);
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

test('redacts sensitive headers with the configured placeholder', () => {
  const { redaction } = loadConfig();
  assert.equal(redactHeaders({ authorization: 'Bearer x', 'content-type': 'text/plain' }, redaction).authorization, placeholder);
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
    assert.equal(config.maxDelayMs, defaults.mocks.maxDelayMs);
    assert.equal(config.name, appJson.name);
    assert.deepEqual(config.ui, appJson.ui);
    assert.deepEqual(config.routes, appJson.routes);
    assert.deepEqual(config.messages, JSON.parse(readFileSync(new URL('../config/messages.json', import.meta.url), 'utf8')).ui);
  } finally { await app.close(); }
});

test('dashboard responds with HTML and the dashboard security headers; HEAD works', async () => {
  const app = await setup();
  try {
    const r = await fetch(app.origin);
    assert.equal(r.status, 200);
    for (const [name, value] of Object.entries(appJson.security.dashboardHeaders)) assert.equal(r.headers.get(name), value);
    const html = await r.text();
    assert.doesNotMatch(html, /\{\{/, 'every template placeholder must be filled');
    const messagesJson = JSON.parse(readFileSync(new URL('../config/messages.json', import.meta.url), 'utf8'));
    assert.ok(html.includes(messagesJson.html.footer), 'texts come from messages.json');
    assert.ok(html.includes(`data-config-url="${appJson.routes.config}"`), 'routes come from app.json');
    const head = await fetch(app.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { await app.close(); }
});

test('serves stylesheet; dashboard has no inline styles blocked by CSP', async () => {
  const app = await setup();
  try {
    const { styles } = appJson.staticFiles;
    const css = await fetch(`${app.origin}${styles.path}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), styles.type);
    assert.equal(css.headers.get('content-security-policy'), null);
    assert.doesNotMatch(await readFile(uiHtmlPath, 'utf8'), /<style|style=/i);
    assert.ok((await (await fetch(app.origin)).text()).includes(`<link rel="stylesheet" href="${styles.path}">`));
  } finally { await app.close(); }
});

test('serves every file listed in app.json staticFiles', async () => {
  const app = await setup();
  try {
    for (const { path, type } of Object.values(appJson.staticFiles)) {
      const r = await fetch(`${app.origin}${path}`);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('content-type'), type, path);
    }
  } finally { await app.close(); }
});

test('mock rule from config answers with its status, headers, body, and delay', async () => {
  const delayMs = 150;
  const app = await setup({ mocks: { rules: [{ id: 'pay', method: 'POST', path: `${prefix}/payments`, status: 503, headers: { 'Retry-After': '30' }, body: { error: 'down' }, delayMs }] } });
  try {
    const started = Date.now();
    const r = await fetch(`${app.origin}${prefix}/payments`, { method: 'POST', body: 'x' });
    assert.ok(Date.now() - started >= delayMs, 'response must wait for delayMs');
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '30');
    for (const [name, value] of Object.entries(appJson.security.mockHeaders)) assert.equal(r.headers.get(name), value);
    assert.deepEqual(await r.json(), { error: 'down' });
    assert.deepEqual(app.events.items[0].response, { status: 503, mockId: 'pay', mockPath: `${prefix}/payments`, delayMs });
    assert.equal(r.headers.get(appJson.headers.eventId), app.events.items[0].id);
    const other = await fetch(`${app.origin}${prefix}/payments`);
    assert.equal(other.status, appJson.defaultResponse.status, 'method must match');
  } finally { await app.close(); }
});

test('mock API adds rules in front, lists, deletes one, and clears all', async () => {
  const app = await setup({ mocks: { rules: [{ path: `${prefix}/*`, status: 202 }] } });
  try {
    assert.equal((await fetch(`${app.origin}${prefix}/a`)).status, 202);
    const created = await postJson(`${app.origin}/api/mocks`, { path: `${prefix}/a`, status: 418, body: 'teapot' });
    assert.equal(created.status, 201);
    const { rule } = await created.json();
    const a = await fetch(`${app.origin}${prefix}/a`);
    assert.equal(a.status, 418, 'API rule must override the config rule');
    assert.equal(await a.text(), 'teapot');
    assert.equal(a.headers.get('content-type'), appJson.contentTypes.text);
    const { rules } = await (await fetch(`${app.origin}/api/mocks`)).json();
    assert.deepEqual(rules.map(r => r.id), [rule.id, `${appJson.mocks.configRuleIdPrefix}1`]);
    assert.equal((await fetch(`${app.origin}/api/mocks/${rule.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${app.origin}/api/mocks/${rule.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${app.origin}${prefix}/a`)).status, 202);
    assert.equal((await fetch(`${app.origin}/api/mocks`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${app.origin}${prefix}/a`)).status, appJson.defaultResponse.status);
  } finally { await app.close(); }
});

test('mock API rejects bad input', async () => {
  const app = await setup({ mocks: { maxRules: 1 } });
  try {
    assert.equal((await fetch(`${app.origin}/api/mocks`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(`${app.origin}/api/mocks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
    const invalid = await postJson(`${app.origin}/api/mocks`, { path: '/elsewhere', status: 99, delayMs: defaults.mocks.maxDelayMs + 1 });
    assert.equal(invalid.status, 400);
    const { error } = await invalid.json();
    assert.match(error, /path/); assert.match(error, /status/); assert.match(error, /delayMs/);
    assert.equal((await postJson(`${app.origin}/api/mocks`, { id: 'one', path: prefix })).status, 201);
    assert.equal((await postJson(`${app.origin}/api/mocks`, { path: prefix })).status, 400, 'maxRules reached');
  } finally { await app.close(); }
});

test('duplicate mock id is rejected with 409', async () => {
  const app = await setup();
  try {
    assert.equal((await postJson(`${app.origin}/api/mocks`, { id: 'same', path: prefix })).status, 201);
    assert.equal((await postJson(`${app.origin}/api/mocks`, { id: 'same', path: prefix })).status, 409);
  } finally { await app.close(); }
});

test('event list filters by method, path pattern, and since', async () => {
  const app = await setup({ capture: { maxEvents: 10 } });
  try {
    await fetch(`${app.origin}${prefix}/orders/1`, { method: 'POST', body: 'a' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const since = new Date().toISOString();
    await fetch(`${app.origin}${prefix}/orders/2`, { method: 'PUT', body: 'b' });
    await fetch(`${app.origin}${prefix}/users/1`, { method: 'POST', body: 'c' });
    const list = async query => (await (await fetch(`${app.origin}/api/events?${query}`)).json());
    assert.equal((await list('method=post')).count, 2);
    assert.equal((await list(`path=${prefix}/orders/*`)).count, 2);
    assert.equal((await list(`path=${prefix}/orders/*&method=PUT`)).events[0].path, `${prefix}/orders/2`);
    const recent = await list(`since=${encodeURIComponent(since)}`);
    assert.equal(recent.count, 2);
    assert.equal(recent.total, 3);
    assert.equal((await fetch(`${app.origin}/api/events?since=yesterday`)).status, 400);
    assert.equal((await fetch(`${app.origin}/api/events?path=orders`)).status, 400);
  } finally { await app.close(); }
});

test('wait returns the oldest stored match at once', async () => {
  const app = await setup({ capture: { maxEvents: 10 } });
  try {
    await fetch(`${app.origin}${prefix}/a`, { method: 'POST', body: 'first' });
    await fetch(`${app.origin}${prefix}/a`, { method: 'POST', body: 'second' });
    const r = await fetch(`${app.origin}/api/events/wait?path=${prefix}/a&timeout=0`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).event.body, 'first');
  } finally { await app.close(); }
});

test('wait blocks until a matching request arrives', async () => {
  const app = await setup();
  try {
    const since = new Date().toISOString();
    const waiting = fetch(`${app.origin}/api/events/wait?method=POST&path=${prefix}/later&since=${encodeURIComponent(since)}&timeout=5000`);
    await fetch(`${app.origin}${prefix}/other`, { method: 'POST', body: 'no' });
    await fetch(`${app.origin}${prefix}/later`, { method: 'POST', body: 'yes' });
    const r = await waiting;
    assert.equal(r.status, 200);
    assert.equal((await r.json()).event.body, 'yes');
  } finally { await app.close(); }
});

test('wait times out with 408 and validates timeout', async () => {
  const app = await setup();
  try {
    assert.equal((await fetch(`${app.origin}/api/events/wait?path=${prefix}/never&timeout=100`)).status, 408);
    assert.equal((await fetch(`${app.origin}/api/events/wait?timeout=${defaults.wait.maxTimeoutMs + 1}`)).status, 400);
    assert.equal((await fetch(`${app.origin}/api/events/wait?timeout=abc`)).status, 400);
  } finally { await app.close(); }
});

test('export returns redacted events with responses and the active mocks', async () => {
  const app = await setup({ mocks: { rules: [{ path: `${prefix}/x`, status: 500 }] } });
  try {
    await fetch(`${app.origin}${prefix}/x`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: 'x' });
    await fetch(`${app.origin}${prefix}/y`, { method: 'POST', body: 'y' });
    const r = await fetch(`${app.origin}/api/events/export?path=${prefix}/x`);
    assert.equal(r.status, 200);
    for (const [name, template] of Object.entries(appJson.export.headers)) {
      const fileName = appJson.export.fileName.replace('{time}', '[0-9TZ-]+');
      assert.match(r.headers.get(name), new RegExp(`^${template.replace('{fileName}', fileName).replace(/[".]/g, '\\$&')}$`));
    }
    const data = await r.json();
    assert.equal(data.tool, appJson.export.tool);
    assert.equal(data.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(data.count, 1);
    assert.equal(data.events[0].headers.authorization, placeholder);
    assert.equal(data.events[0].response.status, 500);
    assert.equal(data.mocks.length, 1);
  } finally { await app.close(); }
});

test('HEAD to a mocked path gets the status and headers without a body', async () => {
  const app = await setup({ mocks: { rules: [{ path: `${prefix}/h`, status: 404, body: 'gone' }] } });
  try {
    const r = await rawRequest(app.port, { method: 'HEAD', path: `${prefix}/h` });
    assert.equal(r.status, 404);
    assert.equal(r.headers['content-type'], appJson.contentTypes.text);
    assert.equal(r.body, '');
  } finally { await app.close(); }
});

test('a mock rule cannot remove the headers that are always sent', async () => {
  const always = appJson.responseHeaders.always;
  const overrides = Object.fromEntries(Object.keys(always).map(name => [name, 'overridden']));
  const app = await setup({ mocks: { rules: [{ path: `${prefix}/h`, headers: { ...overrides, 'content-security-policy': 'default-src *' } }] } });
  try {
    const r = await fetch(`${app.origin}${prefix}/h`);
    for (const [name, value] of Object.entries(always)) assert.equal(r.headers.get(name), value);
    for (const [name, value] of Object.entries(appJson.security.mockHeaders)) assert.equal(r.headers.get(name), value);
  } finally { await app.close(); }
});

test('a wait cancelled by the client does not break later waits', async () => {
  const app = await setup();
  try {
    const controller = new AbortController();
    const cancelled = fetch(`${app.origin}/api/events/wait?path=${prefix}/x&timeout=5000`, { signal: controller.signal }).catch(error => error.name);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    assert.equal(await cancelled, 'AbortError');
    const waiting = fetch(`${app.origin}/api/events/wait?path=${prefix}/x&timeout=5000`);
    await fetch(`${app.origin}${prefix}/x`, { method: 'POST', body: 'ok' });
    assert.equal((await (await waiting).json()).event.body, 'ok');
  } finally { await app.close(); }
});

test('works on IPv6 loopback, including replay', async t => {
  const app = createApp({ config: loadConfig({ overrides: { server: { host: '::1', allowedHostnames: ['[::1]'] } } }) });
  try { app.server.listen(0, '::1'); await once(app.server, 'listening'); }
  catch { t.skip('IPv6 loopback is not available on this machine'); return; }
  const origin = `http://[::1]:${app.server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}${prefix}/v6`, { method: 'POST', body: 'x' })).status, appJson.defaultResponse.status);
    const r = await fetch(`${origin}/api/events/${app.events.items[0].id}/replay`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(app.events.items.length, 2);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});

test('replay of a mocked path reports the mocked status', async () => {
  const app = await setup({ mocks: { rules: [{ path: `${prefix}/fail`, status: 500 }] } });
  try {
    await fetch(`${app.origin}${prefix}/fail`, { method: 'POST', body: 'x' });
    const r = await fetch(`${app.origin}/api/events/${app.events.items[0].id}/replay`, { method: 'POST' });
    assert.equal((await r.json()).responseStatus, 500);
  } finally { await app.close(); }
});

test('starts when launched through a symlink (npm bin link)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hookdesk-'));
  const link = join(dir, 'hookdesk');
  await symlink(cliPath, link);
  const child = spawn(process.execPath, [link, '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes(`${appJson.name} is running`)) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Exited with ${code}. Output: ${output}`)); });
    });
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
