import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRule } from '../mocks/rules.js';
import { app, limits, messages, format, inRange, rangeText, urlHost } from './fixed.js';

const M = messages.config;
export const defaultConfigPath = fileURLToPath(new URL('../../config/default.json', import.meta.url));

function readConfigFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(format(M.cannotRead, { path, reason: error.message })); }
}

// Merges one level deep: each section is merged key by key, arrays are replaced whole.
// Unknown sections and keys are rejected so typos never pass silently.
export function mergeConfig(base, override = {}) {
  const merged = {};
  for (const [section, values] of Object.entries(override)) {
    if (!(section in base)) throw new Error(format(M.unknownSection, { section }));
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(format(M.sectionNotObject, { section }));
    for (const key of Object.keys(values)) if (!(key in base[section])) throw new Error(format(M.unknownKey, { section, key }));
  }
  for (const section of Object.keys(base)) merged[section] = { ...base[section], ...(override[section] || {}) };
  return merged;
}

const isStringList = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0);

function validateConfig(config) {
  const { server, capture, replay, redaction, mocks, wait, ui } = config;
  const L = limits;
  const join = list => list.join(M.listSeparator);
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  const range = (section, key) => check(inRange(config[section][key], L[section][key]), format(M.range, { key: `${section}.${key}`, range: rangeText(L[section][key]) }));
  const stringList = (section, key) => check(isStringList(config[section][key]), format(M.stringList, { key: `${section}.${key}` }));

  check(L.server.loopbackHosts.includes(server.host), format(M.loopbackHost, { hosts: join(L.server.loopbackHosts) }));
  range('server', 'port');
  check(isStringList(server.allowedHostnames) && server.allowedHostnames.length > 0 && server.allowedHostnames.every(x => L.server.loopbackHostnames.includes(x)), format(M.allowedHostnames, { hosts: join(L.server.loopbackHostnames) }));
  check(isStringList(server.allowedHostnames) && server.allowedHostnames.includes(urlHost(server.host)), M.allowedHostnamesIncludeHost);
  check(typeof capture.pathPrefix === 'string' && new RegExp(L.capture.pathPrefixPattern).test(capture.pathPrefix) && !new RegExp(L.capture.reservedPathPattern).test(capture.pathPrefix), M.pathPrefix);
  range('capture', 'maxBodyBytes');
  range('capture', 'maxEvents');
  range('replay', 'timeoutMs');
  stringList('replay', 'blockedMethods');
  stringList('replay', 'excludedHeaders');
  check(typeof redaction.placeholder === 'string' && redaction.placeholder.length > 0, M.placeholder);
  stringList('redaction', 'sensitiveHeaders');
  range('mocks', 'maxDelayMs');
  range('mocks', 'maxRules');
  if (!Array.isArray(mocks.rules)) errors.push(M.rulesList);
  else {
    check(mocks.rules.length <= mocks.maxRules, M.rulesOverLimit);
    const ids = mocks.rules.map(rule => rule?.id).filter(id => id !== undefined);
    check(new Set(ids).size === ids.length, M.ruleIdsUnique);
    mocks.rules.forEach((rule, index) => {
      try { parseRule(rule, { pathPrefix: capture.pathPrefix, maxDelayMs: mocks.maxDelayMs }, format(messages.rules.configLabel, { index })); }
      catch (error) { errors.push(...error.errors); }
    });
  }
  range('wait', 'maxTimeoutMs');
  range('wait', 'defaultTimeoutMs');
  check(wait.defaultTimeoutMs <= wait.maxTimeoutMs, M.waitDefaultOverMax);
  range('ui', 'pollIntervalMs');
  range('ui', 'timelineWindowMs');
  check(L.ui.themes.includes(ui.defaultTheme), format(M.theme, { themes: join(L.ui.themes) }));
  stringList('ui', 'curlExcludedHeaders');
  if (errors.length) throw new Error(format(M.invalid, { errors: errors.join(M.errorSeparator) }));
}

function normalize(config) {
  const lower = list => list.map(x => x.toLowerCase());
  const ruleLimits = { pathPrefix: config.capture.pathPrefix, maxDelayMs: config.mocks.maxDelayMs };
  return {
    ...config,
    replay: { ...config.replay, blockedMethods: config.replay.blockedMethods.map(x => x.toUpperCase()), excludedHeaders: lower(config.replay.excludedHeaders) },
    redaction: { ...config.redaction, sensitiveHeaders: lower(config.redaction.sensitiveHeaders) },
    // Config rules without an id get one from their position, so they can be removed through the API.
    mocks: { ...config.mocks, rules: config.mocks.rules.map((rule, i) => ({ ...parseRule(rule, ruleLimits), id: rule.id ?? `${app.mocks.configRuleIdPrefix}${i + 1}` })) },
    ui: { ...config.ui, curlExcludedHeaders: lower(config.ui.curlExcludedHeaders) },
  };
}

const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

// Precedence: config/default.json < file (--config) < overrides (PORT, --port, tests).
export function loadConfig({ file, overrides } = {}) {
  let config = readConfigFile(defaultConfigPath);
  if (file) config = mergeConfig(config, readConfigFile(file));
  if (overrides) config = mergeConfig(config, overrides);
  validateConfig(config);
  return deepFreeze(normalize(config));
}
