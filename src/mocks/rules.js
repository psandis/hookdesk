import { randomUUID } from 'node:crypto';
import { app, limits, messages, format, httpError, inRange, rangeText } from '../loader/fixed.js';

// Mock response rules: the status, headers, body, and delay a captured request gets back.
const M = messages.rules;
const RULE_KEYS = new Set(limits.mocks.ruleKeys);
const { status: STATUS, statusWithoutBody, reservedHeaders } = limits.mocks;
const { anyMethod: ANY_METHOD, prefixSuffix: PREFIX, ruleDefaults: DEFAULTS } = app.mocks;
const METHOD = new RegExp(limits.mocks.methodPattern);
const ID = new RegExp(limits.mocks.idPattern);
const PATH = new RegExp(limits.mocks.pathPattern);
const HEADER_NAME = new RegExp(limits.mocks.headerNamePattern);
const HEADER_VALUE_FORBIDDEN = new RegExp(limits.mocks.headerValueForbiddenPattern);
const RESERVED = new Set(reservedHeaders);

// "/hook/a" matches only that path; "/hook/a/*" matches "/hook/a" and everything below it.
const baseOf = pattern => pattern.endsWith(PREFIX) ? pattern.slice(0, -PREFIX.length) : null;
export function matchPath(pattern, pathname) {
  const base = baseOf(pattern);
  if (base === null) return pathname === pattern;
  return pathname === base || pathname.startsWith(`${base}/`);
}

const matchRule = (rule, method, pathname) => (rule.method === ANY_METHOD || rule.method === method) && matchPath(rule.path, pathname);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Validates one rule and returns it normalized. Throws an Error whose `errors` lists every problem.
export function parseRule(input, { pathPrefix, maxDelayMs }, label = M.defaultLabel) {
  if (!isPlainObject(input)) { const message = format(M.notObject, { label }); throw Object.assign(new Error(message), { errors: [message] }); }
  const errors = [];
  for (const key of Object.keys(input)) if (!RULE_KEYS.has(key)) errors.push(format(M.unknownKey, { label, key }));
  if (input.id !== undefined && (typeof input.id !== 'string' || !ID.test(input.id))) errors.push(format(M.id, { label, pattern: limits.mocks.idPattern }));

  const method = input.method === undefined ? ANY_METHOD : typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (!METHOD.test(method)) errors.push(format(M.method, { label, any: ANY_METHOD }));

  const { path } = input;
  const base = typeof path === 'string' ? baseOf(path) ?? path : path;
  if (typeof path !== 'string' || !PATH.test(base) || !(base === pathPrefix || base.startsWith(`${pathPrefix}/`))) {
    errors.push(format(M.path, { label, prefix: pathPrefix, suffix: PREFIX }));
  }

  const status = input.status ?? DEFAULTS.status;
  if (!inRange(status, STATUS)) errors.push(format(M.status, { label, range: rangeText(STATUS) }));
  const delayMs = input.delayMs ?? DEFAULTS.delayMs;
  const delayRange = { min: limits.mocks.maxDelayMs.min, max: maxDelayMs };
  if (!inRange(delayMs, delayRange)) errors.push(format(M.delay, { label, range: rangeText(delayRange) }));

  const headers = {};
  if (input.headers !== undefined) {
    if (!isPlainObject(input.headers)) errors.push(format(M.headersObject, { label }));
    else for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name)) errors.push(format(M.headerName, { label, name }));
      else if (RESERVED.has(lower)) errors.push(format(M.headerReserved, { label, name: lower }));
      else if (typeof value !== 'string' || HEADER_VALUE_FORBIDDEN.test(value)) errors.push(format(M.headerValue, { label, name }));
      else headers[lower] = value;
    }
  }

  // A string body is sent as is; any other JSON value is serialized and sent as JSON.
  let body = null;
  if (input.body !== undefined && input.body !== null) {
    body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    headers[app.headers.contentType] ??= typeof input.body === 'string' ? app.contentTypes.text : app.contentTypes.json;
  }
  if (body !== null && statusWithoutBody.includes(status)) errors.push(format(M.statusWithoutBody, { label, status }));

  if (errors.length) throw Object.assign(new Error(errors.join(M.separator)), { errors });
  return { id: input.id, method, path, status, headers, body, delayMs };
}

// The live rule list. Rules added at runtime go first, so a test can override a rule from the config file.
export function createMockSet({ rules, maxRules, pathPrefix, maxDelayMs }) {
  const list = [...rules];
  return {
    list,
    match: (method, pathname) => list.find(rule => matchRule(rule, method, pathname)),
    add(input) {
      if (list.length >= maxRules) throw httpError(app.status.badRequest, format(messages.api.ruleLimit, { max: maxRules }));
      let rule;
      try { rule = parseRule(input, { pathPrefix, maxDelayMs }); } catch (error) { throw httpError(app.status.badRequest, error.message); }
      if (rule.id === undefined) do rule.id = randomUUID().slice(0, app.mocks.generatedIdLength); while (list.some(r => r.id === rule.id));
      else if (list.some(r => r.id === rule.id)) throw httpError(app.status.conflict, format(messages.api.ruleDuplicate, { id: rule.id }));
      list.unshift(rule);
      return rule;
    },
    remove(id) {
      const index = list.findIndex(rule => rule.id === id);
      if (index !== -1) list.splice(index, 1);
      return index !== -1;
    },
    clear: () => { list.splice(0); },
  };
}
