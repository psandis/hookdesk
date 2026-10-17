import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const defaultConfigPath = fileURLToPath(new URL('../config/default.json', import.meta.url));
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

export function readConfigFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read config file ${path}: ${error.message}`); }
}

// Merges one level deep: each section is merged key by key, arrays are replaced whole.
// Unknown sections and keys are rejected so typos never pass silently.
export function mergeConfig(base, override = {}) {
  const merged = {};
  for (const [section, values] of Object.entries(override)) {
    if (!(section in base)) throw new Error(`Unknown config section "${section}"`);
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error(`Config section "${section}" must be an object`);
    for (const key of Object.keys(values)) if (!(key in base[section])) throw new Error(`Unknown config key "${section}.${key}"`);
  }
  for (const section of Object.keys(base)) merged[section] = { ...base[section], ...(override[section] || {}) };
  return merged;
}

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isStringList = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0);

export function validateConfig(config) {
  const { server, capture, replay, redaction, ui } = config;
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(LOOPBACK_HOSTS.includes(server.host), `server.host must be a loopback address (${LOOPBACK_HOSTS.join(', ')})`);
  check(isInt(server.port, 0, 65535), 'server.port must be an integer 0..65535 (0 picks a free port)');
  check(isStringList(server.allowedHostnames) && server.allowedHostnames.length > 0 && server.allowedHostnames.every(x => LOOPBACK_HOSTNAMES.includes(x)), `server.allowedHostnames must be a non-empty list of ${LOOPBACK_HOSTNAMES.join(', ')}`);
  check(isStringList(server.allowedHostnames) && server.allowedHostnames.includes(server.host === '::1' ? '[::1]' : server.host), 'server.allowedHostnames must include server.host');
  check(typeof capture.pathPrefix === 'string' && /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(capture.pathPrefix) && !/^\/(api|ui\.)/.test(capture.pathPrefix), 'capture.pathPrefix must look like "/hook" (no trailing slash, not under /api)');
  check(isInt(capture.maxBodyBytes, 1, 100 * 1024 * 1024), 'capture.maxBodyBytes must be an integer 1..104857600');
  check(isInt(capture.maxEvents, 1, 100000), 'capture.maxEvents must be an integer 1..100000');
  check(isInt(replay.timeoutMs, 100, 60000), 'replay.timeoutMs must be an integer 100..60000');
  check(isStringList(replay.blockedMethods), 'replay.blockedMethods must be a list of method names');
  check(isStringList(replay.excludedHeaders), 'replay.excludedHeaders must be a list of header names');
  check(typeof redaction.placeholder === 'string' && redaction.placeholder.length > 0, 'redaction.placeholder must be a non-empty string');
  check(isStringList(redaction.sensitiveHeaders), 'redaction.sensitiveHeaders must be a list of header names');
  check(isInt(ui.pollIntervalMs, 250, 60000), 'ui.pollIntervalMs must be an integer 250..60000');
  check(isInt(ui.timelineWindowMs, 10000, 86400000), 'ui.timelineWindowMs must be an integer 10000..86400000');
  check(['auto', 'light', 'dark'].includes(ui.defaultTheme), 'ui.defaultTheme must be "auto", "light" or "dark"');
  check(isStringList(ui.curlExcludedHeaders), 'ui.curlExcludedHeaders must be a list of header names');
  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
}

function normalize(config) {
  const lower = list => list.map(x => x.toLowerCase());
  return {
    ...config,
    replay: { ...config.replay, blockedMethods: config.replay.blockedMethods.map(x => x.toUpperCase()), excludedHeaders: lower(config.replay.excludedHeaders) },
    redaction: { ...config.redaction, sensitiveHeaders: lower(config.redaction.sensitiveHeaders) },
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
