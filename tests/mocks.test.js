import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMockSet, matchPath, parseRule } from '../src/mocks/rules.js';

const limits = JSON.parse(readFileSync(new URL('../config/limits.json', import.meta.url), 'utf8')).mocks;
const { contentTypes } = JSON.parse(readFileSync(new URL('../config/app.json', import.meta.url), 'utf8'));
const ruleLimits = { pathPrefix: '/hook', maxDelayMs: 1000 };

test('matchPath: exact paths and "/*" prefixes', () => {
  assert.ok(matchPath('/hook/a', '/hook/a'));
  assert.ok(!matchPath('/hook/a', '/hook/a/b'));
  assert.ok(matchPath('/hook/a/*', '/hook/a'));
  assert.ok(matchPath('/hook/a/*', '/hook/a/b/c'));
  assert.ok(!matchPath('/hook/a/*', '/hook/ab'));
});

test('parseRule fills defaults and normalizes', () => {
  assert.deepEqual(parseRule({ path: '/hook/x' }, ruleLimits), { id: undefined, method: '*', path: '/hook/x', status: 200, headers: {}, body: null, delayMs: 0 });
  const rule = parseRule({ method: 'post', path: '/hook/*', headers: { 'X-Test': 'a' }, body: { ok: true } }, ruleLimits);
  assert.equal(rule.method, 'POST');
  assert.deepEqual(rule.headers, { 'x-test': 'a', 'content-type': contentTypes.json });
  assert.equal(rule.body, '{"ok":true}');
  assert.equal(parseRule({ path: '/hook', body: 'hi' }, ruleLimits).headers['content-type'], contentTypes.text);
  assert.equal(parseRule({ path: '/hook', body: 'hi', headers: { 'Content-Type': 'text/html' } }, ruleLimits).headers['content-type'], 'text/html');
});

test('parseRule rejects every invalid field and lists all problems', () => {
  const tooSlow = ruleLimits.maxDelayMs + 1;
  try {
    parseRule({ path: '/other', status: limits.status.max + 1, delayMs: tooSlow, method: 1, id: 'bad id', extra: 1 }, ruleLimits);
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error.errors.length, 6);
    for (const word of ['path', 'status', 'delayMs', 'method', 'id', 'extra']) assert.match(error.message, new RegExp(word));
  }
  assert.throws(() => parseRule('nope', ruleLimits), /must be an object/);
  assert.throws(() => parseRule({ path: '/hook?x=1' }, ruleLimits), /path/);
  for (const name of limits.reservedHeaders) assert.throws(() => parseRule({ path: '/hook', headers: { [name]: '1' } }, ruleLimits), /set by the server/);
  assert.throws(() => parseRule({ path: '/hook', headers: { 'x-a': 'line\nbreak' } }, ruleLimits), /single-line/);
  for (const status of limits.statusWithoutBody) assert.throws(() => parseRule({ path: '/hook', status, body: 'x' }, ruleLimits), /cannot have a body/);
});

test('createMockSet: first match wins, runtime rules go first, ids are unique', () => {
  const set = createMockSet({ rules: [parseRule({ id: 'all', path: '/hook/*', status: 201 }, ruleLimits)], maxRules: 2, ...ruleLimits });
  assert.equal(set.match('GET', '/hook/a').id, 'all');
  const added = set.add({ method: 'GET', path: '/hook/a', status: 404 });
  assert.equal(typeof added.id, 'string');
  assert.equal(set.match('GET', '/hook/a').status, 404);
  assert.equal(set.match('POST', '/hook/a').status, 201);
  assert.equal(set.match('GET', '/elsewhere'), undefined);
  assert.throws(() => set.add({ path: '/hook' }), error => error.status === 400);
  assert.ok(set.remove('all'));
  assert.ok(!set.remove('all'));
  assert.throws(() => set.add({ id: added.id, path: '/hook' }), error => error.status === 409);
  set.clear();
  assert.equal(set.list.length, 0);
});
