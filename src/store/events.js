import { matchPath } from '../mocks/rules.js';

// Builds a predicate from optional filters: method, path (exact or ending in "/*"), and since (epoch ms, inclusive).
export const createFilter = ({ method, path, since }) => event =>
  (!method || event.method === method) && (!path || matchPath(path, event.pathname)) && (since === undefined || Date.parse(event.timestamp) >= since);

// In-memory request history, newest first, plus waiters that resolve when a matching request arrives.
export function createEventStore({ maxEvents }) {
  const items = [];
  const waiters = new Set();
  return {
    items,
    add(event) {
      items.unshift(event);
      if (items.length > maxEvents) items.length = maxEvents;
      for (const waiter of [...waiters]) if (waiter.matches(event)) waiter.done(event);
    },
    find: id => items.find(event => event.id === id),
    filter: matches => items.filter(matches),
    clear: () => { items.splice(0); },
    // Resolves with the oldest stored match, else the next one to arrive; null on timeout; undefined if aborted.
    waitFor(matches, timeoutMs, signal) {
      const stored = items.findLast(matches);
      if (stored || timeoutMs === 0) return Promise.resolve(stored ?? null);
      return new Promise(resolve => {
        const waiter = { matches, done: result => { if (!waiters.delete(waiter)) return; clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(result); } };
        const onAbort = () => waiter.done(undefined);
        const timer = setTimeout(() => waiter.done(null), timeoutMs);
        waiters.add(waiter);
        signal.addEventListener('abort', onAbort);
      });
    },
  };
}
