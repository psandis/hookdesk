import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadConfig, mergeConfig } from '../src/config.js';

// Expected defaults come from the data file, so changing config/default.json never breaks tests.
// Literal values below are either test inputs or security invariants.
const defaults = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
const lowerAll = value => JSON.parse(JSON.stringify(value).toLowerCase());

async function withConfigFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hookdesk-config-'));
  const file = join(dir, 'config.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  try { return await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('loads config/default.json unchanged apart from casing', () => {
  assert.deepEqual(lowerAll(loadConfig()), lowerAll(defaults));
});

test('security invariants hold in the defaults', () => {
  const config = loadConfig();
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.server.host), 'must bind to loopback only');
  assert.ok(config.redaction.sensitiveHeaders.includes('authorization'), 'authorization must always be redacted');
  for (const method of ['CONNECT', 'TRACE', 'TRACK']) assert.ok(config.replay.blockedMethods.includes(method), `fetch() cannot send ${method}, so it must be blocked`);
});

test('config file overrides only the keys it sets', () => {
  const maxEvents = defaults.capture.maxEvents + 1;
  return withConfigFile({ capture: { maxEvents } }, file => {
    const config = loadConfig({ file });
    assert.equal(config.capture.maxEvents, maxEvents);
    assert.equal(config.capture.maxBodyBytes, defaults.capture.maxBodyBytes);
    assert.equal(config.server.port, defaults.server.port);
  });
});

test('overrides win over the config file', () => withConfigFile({ server: { port: 5000 } }, file => {
  assert.equal(loadConfig({ file, overrides: { server: { port: 6000 } } }).server.port, 6000);
}));

test('rejects unknown sections and keys', () => {
  assert.throws(() => loadConfig({ overrides: { nope: {} } }), /Unknown config section "nope"/);
  assert.throws(() => loadConfig({ overrides: { capture: { maxEvent: 5 } } }), /Unknown config key "capture.maxEvent"/);
});

test('rejects non-loopback hosts', () => {
  assert.throws(() => loadConfig({ overrides: { server: { host: '0.0.0.0' } } }), /server.host must be a loopback/);
  assert.throws(() => loadConfig({ overrides: { server: { allowedHostnames: ['127.0.0.1', 'example.com'] } } }), /allowedHostnames/);
});

test('rejects invalid values with a readable message', () => {
  assert.throws(() => loadConfig({ overrides: { server: { port: Number('abc') } } }), /server.port/);
  assert.throws(() => loadConfig({ overrides: { capture: { pathPrefix: '/api/x' } } }), /capture.pathPrefix/);
  assert.throws(() => loadConfig({ overrides: { ui: { pollIntervalMs: 10 } } }), /ui.pollIntervalMs/);
  assert.throws(() => loadConfig({ overrides: { ui: { timelineWindowMs: 500 } } }), /ui.timelineWindowMs/);
  assert.throws(() => loadConfig({ overrides: { ui: { defaultTheme: 'neon' } } }), /ui.defaultTheme/);
});

test('accepts every supported theme', () => {
  for (const theme of ['auto', 'light', 'dark']) assert.equal(loadConfig({ overrides: { ui: { defaultTheme: theme } } }).ui.defaultTheme, theme);
});

test('reports unreadable or malformed config files', async () => {
  assert.throws(() => loadConfig({ file: '/does/not/exist.json' }), /Cannot read config file/);
  await withConfigFile('{ not json', file => assert.throws(() => loadConfig({ file }), /Cannot read config file/));
});

test('normalizes header and method casing and freezes the result', () => {
  const config = loadConfig({ overrides: { redaction: { sensitiveHeaders: ['X-Secret'] }, replay: { blockedMethods: ['trace'] } } });
  assert.deepEqual(config.redaction.sensitiveHeaders, ['x-secret']);
  assert.deepEqual(config.replay.blockedMethods, ['TRACE']);
  assert.ok(Object.isFrozen(config.capture));
});

test('mergeConfig replaces arrays instead of concatenating', () => {
  const merged = mergeConfig({ ui: { list: ['a', 'b'] } }, { ui: { list: ['c'] } });
  assert.deepEqual(merged.ui.list, ['c']);
});
