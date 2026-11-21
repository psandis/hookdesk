import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore, createFilter } from '../src/store/events.js';

const event = (id, fields = {}) => ({ id, method: 'POST', pathname: '/hook/a', timestamp: new Date().toISOString(), ...fields });
const never = new AbortController().signal;

test('store keeps newest first and trims to maxEvents', () => {
  const store = createEventStore({ maxEvents: 2 });
  store.add(event('1')); store.add(event('2')); store.add(event('3'));
  assert.deepEqual(store.items.map(e => e.id), ['3', '2']);
  assert.equal(store.find('2').id, '2');
  assert.equal(store.find('1'), undefined);
  store.clear();
  assert.equal(store.items.length, 0);
});

test('createFilter combines method, path pattern, and since', () => {
  const old = event('old', { timestamp: '2026-01-01T00:00:00.000Z' });
  const recent = event('new', { method: 'PUT', pathname: '/hook/b/c', timestamp: '2026-02-01T00:00:00.000Z' });
  assert.ok(createFilter({ method: 'PUT' })(recent));
  assert.ok(!createFilter({ method: 'PUT' })(old));
  assert.ok(createFilter({ path: '/hook/b/*' })(recent));
  assert.ok(!createFilter({ path: '/hook/b' })(recent));
  assert.ok(createFilter({ since: Date.parse('2026-02-01T00:00:00.000Z') })(recent), 'since is inclusive');
  assert.ok(!createFilter({ since: Date.parse('2026-01-15T00:00:00.000Z') })(old));
  assert.ok(createFilter({})(old));
});

test('waitFor resolves with the oldest stored match, a later match, null on timeout, or undefined on abort', async () => {
  const store = createEventStore({ maxEvents: 10 });
  store.add(event('first')); store.add(event('second'));
  assert.equal((await store.waitFor(() => true, 0, never)).id, 'first');
  assert.equal(await store.waitFor(e => e.id === 'x', 0, never), null);

  const later = store.waitFor(e => e.id === 'later', 1000, never);
  store.add(event('other'));
  store.add(event('later'));
  assert.equal((await later).id, 'later');

  assert.equal(await store.waitFor(e => e.id === 'none', 20, never), null);

  const abort = new AbortController();
  const aborted = store.waitFor(e => e.id === 'none', 1000, abort.signal);
  abort.abort();
  assert.equal(await aborted, undefined);
});
