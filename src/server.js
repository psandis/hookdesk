import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, limits, messages, format, httpError, rangeText, urlHost } from './loader/fixed.js';
import { loadConfig } from './loader/settings.js';
import { createMockSet } from './mocks/rules.js';
import { createEventStore, createFilter } from './store/events.js';

const VERSION = JSON.parse(readFileSync(new URL(app.packageFile, import.meta.url), 'utf8')).version;
const M = messages.api;
const S = app.status;
const H = app.methods;
const { contentType: CONTENT_TYPE, replay: REPLAY_HEADER, eventId: EVENT_ID_HEADER } = app.headers;
const { defaults: DEFAULT_HEADERS, always: ALWAYS_HEADERS, onPayloadTooLarge: TOO_LARGE_HEADERS } = app.responseHeaders;
const HOST_HEADER = new RegExp(limits.server.hostHeaderPattern);
const API_CONTENT_TYPE = new RegExp(limits.mocks.apiContentTypePattern, 'i');
const SCHEME = `${app.scheme}:`;

// "/api/events/{id}" becomes a pattern that captures the id.
const escapeRegExp = text => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const routePattern = template => new RegExp(`^${template.split(/\{\w+\}/).map(escapeRegExp).join('([^/]+)')}$`);
const EVENT_ROUTE = routePattern(app.routes.event);
const REPLAY_ROUTE = routePattern(app.routes.replay);
const MOCK_ROUTE = routePattern(app.routes.mock);
const STATIC_BY_PATH = new Map(Object.values(app.staticFiles).map(file => [file.path, file]));

// The dashboard page is a template: {{t.key}} is a text from messages.json, {{routes.key}} and {{ui.key}} come from app.json.
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const templateValues = { t: messages.html, routes: app.routes, ui: app.ui, staticFiles: app.staticFiles, messages: { ui: messages.ui } };
const renderTemplate = html => html.replace(/\{\{([\w.]+)\}\}/g, (match, path) => {
  const value = path.split('.').reduce((obj, key) => obj?.[key], templateValues);
  return value === undefined ? match : escapeHtml(value);
});

export function redactHeaders(headers, { sensitiveHeaders, placeholder }) {
  const sensitive = new Set(sensitiveHeaders);
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitive.has(key.toLowerCase()) ? placeholder : value]));
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw httpError(S.payloadTooLarge, format(M.payloadTooLarge, { limit }));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function respond(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { [CONTENT_TYPE]: app.contentTypes.json, ...DEFAULT_HEADERS, ...ALWAYS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(value));
}
const fail = (res, status, message) => respond(res, status, { error: message });

const summarize = ({ id, timestamp, method, path, bytes, replayOf, response }) => ({ id, timestamp, method, path, bytes, replayOf, status: response.status, mockId: response.mockId });
const hostnameOf = value => { try { return new URL(`${SCHEME}//${value}`).hostname; } catch { return null; } };

// ?method=POST&path=/hook/a/*&since=<ISO 8601>, shared by list, wait, and export.
function filterFromQuery(params) {
  const Q = app.query;
  const path = params.get(Q.path);
  const sinceText = params.get(Q.since);
  const since = sinceText === null ? undefined : Date.parse(sinceText);
  if (path !== null && !path.startsWith('/')) throw httpError(S.badRequest, M.pathMustStartWithSlash);
  if (Number.isNaN(since)) throw httpError(S.badRequest, M.sinceInvalid);
  return createFilter({ method: params.get(Q.method)?.toUpperCase(), path, since });
}

export function createApp({ config = loadConfig() } = {}) {
  const { capture, replay, redaction, mocks: mockConfig, wait, ui } = config;
  const events = createEventStore({ maxEvents: capture.maxEvents });
  const mocks = createMockSet({ rules: mockConfig.rules, maxRules: mockConfig.maxRules, pathPrefix: capture.pathPrefix, maxDelayMs: mockConfig.maxDelayMs });
  const allowedHostnames = new Set(config.server.allowedHostnames);
  const listenHost = urlHost(config.server.host);
  const notForwarded = new Set([...redaction.sensitiveHeaders, ...replay.excludedHeaders, REPLAY_HEADER]);
  const waitRange = { min: limits.wait.defaultTimeoutMs.min, max: wait.maxTimeoutMs };
  const safeView = ({ pathname, ...event }) => ({ ...event, headers: redactHeaders(event.headers, redaction) });
  const publicConfig = {
    version: VERSION, name: app.name, ui: app.ui, routes: app.routes, methods: app.methods, messages: messages.ui, headers: app.headers, contentTypes: app.contentTypes,
    anyMethod: app.mocks.anyMethod, prefixSuffix: app.mocks.prefixSuffix, mockRuleDefaults: app.mocks.ruleDefaults, statusRange: limits.mocks.status, minDelayMs: limits.mocks.maxDelayMs.min,
    examplePath: app.cli.examplePath, exampleContentType: app.cli.exampleContentType, exampleBody: app.cli.exampleBody, exampleCommand: messages.cli.exampleCommand,
    themes: limits.ui.themes, host: config.server.host, captureBase: capture.pathPrefix, maxEvents: capture.maxEvents, maxBodyBytes: capture.maxBodyBytes, maxDelayMs: mockConfig.maxDelayMs,
    pollIntervalMs: ui.pollIntervalMs, timelineWindowMs: ui.timelineWindowMs, defaultTheme: ui.defaultTheme, curlExcludedHeaders: ui.curlExcludedHeaders, redactedPlaceholder: redaction.placeholder,
  };

  async function captureRequest(req, res, url) {
    const body = await readBody(req, capture.maxBodyBytes);
    const rule = mocks.match(req.method, url.pathname);
    const response = rule ? { status: rule.status, mockId: rule.id, mockPath: rule.path, delayMs: rule.delayMs } : { status: app.defaultResponse.status, mockId: null, mockPath: null, delayMs: app.mocks.ruleDefaults.delayMs };
    const event = { id: randomUUID(), timestamp: new Date().toISOString(), method: req.method, path: url.pathname + url.search, pathname: url.pathname, headers: { ...req.headers }, body, bytes: Buffer.byteLength(body), replayOf: req.headers[REPLAY_HEADER] || null, response };
    events.add(event);
    if (!rule) return respond(res, app.defaultResponse.status, { ...app.defaultResponse.body, id: event.id }, { [EVENT_ID_HEADER]: event.id });
    if (rule.delayMs) await sleep(rule.delayMs);
    if (res.destroyed) return;
    // Mock bodies are served from the dashboard origin, so they are sandboxed: a mocked HTML page cannot run scripts here.
    res.writeHead(rule.status, { ...DEFAULT_HEADERS, ...rule.headers, ...ALWAYS_HEADERS, ...app.security.mockHeaders, [EVENT_ID_HEADER]: event.id });
    res.end(req.method === H.head || rule.body === null ? undefined : rule.body);
  }

  async function waitRequest(res, url) {
    const matches = filterFromQuery(url.searchParams);
    const timeoutText = url.searchParams.get(app.query.timeout);
    const timeout = timeoutText === null ? wait.defaultTimeoutMs : Number(timeoutText);
    if (!Number.isInteger(timeout) || timeout < waitRange.min || timeout > waitRange.max) return fail(res, S.badRequest, format(M.timeoutInvalid, { range: rangeText(waitRange) }));
    const closed = new AbortController();
    res.on('close', () => closed.abort());
    const event = await events.waitFor(matches, timeout, closed.signal);
    if (event === undefined) return;
    return event ? respond(res, S.ok, { event: safeView(event) }) : fail(res, S.timeout, format(M.waitTimedOut, { timeout }));
  }

  async function addMock(req, res) {
    if (!API_CONTENT_TYPE.test(req.headers[CONTENT_TYPE] || '')) return fail(res, S.unsupportedMediaType, M.contentTypeJson);
    let input;
    try { input = JSON.parse(await readBody(req, capture.maxBodyBytes)); } catch (error) { if (error.status) throw error; return fail(res, S.badRequest, M.bodyInvalidJson); }
    return respond(res, S.created, { rule: mocks.add(input) });
  }

  async function replayRequest(res, source) {
    if (replay.blockedMethods.includes(source.method)) return fail(res, S.badRequest, format(M.replayBlocked, { method: source.method }));
    // Replay stays inside this app. Credentials, hop-by-hop and browser-controlled headers are never forwarded.
    const headers = Object.fromEntries(Object.entries(source.headers).filter(([key]) => !notForwarded.has(key.toLowerCase())));
    headers[REPLAY_HEADER] = source.id;
    const destination = `${SCHEME}//${listenHost}:${server.address().port}${source.path}`;
    let result;
    try {
      result = await fetch(destination, { method: source.method, headers, body: app.methodsWithoutBody.includes(source.method) ? undefined : source.body, signal: AbortSignal.timeout(replay.timeoutMs) });
      await result.body?.cancel();
    } catch (error) { return fail(res, S.badGateway, format(M.replayFailed, { reason: error.cause?.message || error.message })); }
    return respond(res, S.ok, { ok: true, responseStatus: result.status });
  }

  async function serveStatic(req, res, staticFile) {
    const content = await readFile(new URL(`./${app.uiDirectory}/${staticFile.file}`, import.meta.url));
    res.writeHead(S.ok, { [CONTENT_TYPE]: staticFile.type, ...DEFAULT_HEADERS, ...ALWAYS_HEADERS, ...(staticFile.dashboard ? app.security.dashboardHeaders : {}) });
    res.end(req.method === H.head ? undefined : staticFile.template ? renderTemplate(content.toString()) : content);
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const R = app.routes;
    const staticFile = STATIC_BY_PATH.get(pathname);
    if (staticFile && (req.method === H.get || req.method === H.head)) return serveStatic(req, res, staticFile);
    if (req.method === H.get && pathname === R.config) return respond(res, S.ok, publicConfig);
    if (pathname === R.events) {
      if (req.method === H.get) { const list = events.filter(filterFromQuery(url.searchParams)).map(summarize); return respond(res, S.ok, { events: list, count: list.length, total: events.items.length }); }
      if (req.method === H.delete) { events.clear(); return respond(res, S.ok, { ok: true }); }
    }
    if (req.method === H.get && pathname === R.wait) return waitRequest(res, url);
    if (req.method === H.get && pathname === R.export) {
      const list = events.filter(filterFromQuery(url.searchParams)).map(safeView);
      const exportedAt = new Date().toISOString();
      const fileName = format(app.export.fileName, { time: exportedAt.replace(/[:.]/g, '-') });
      const headers = Object.fromEntries(Object.entries(app.export.headers).map(([name, value]) => [name, format(value, { fileName })]));
      return respond(res, S.ok, { tool: app.export.tool, version: VERSION, exportedAt, count: list.length, mocks: mocks.list, events: list }, headers);
    }
    const replayId = pathname.match(REPLAY_ROUTE)?.[1];
    if (req.method === H.post && replayId) { const event = events.find(replayId); return event ? replayRequest(res, event) : fail(res, S.notFound, M.eventNotFound); }
    const eventId = pathname.match(EVENT_ROUTE)?.[1];
    if (req.method === H.get && eventId) { const event = events.find(eventId); return event ? respond(res, S.ok, { event: safeView(event) }) : fail(res, S.notFound, M.eventNotFound); }
    if (pathname === R.mocks) {
      if (req.method === H.get) return respond(res, S.ok, { rules: mocks.list, maxRules: mockConfig.maxRules, maxDelayMs: mockConfig.maxDelayMs });
      if (req.method === H.post) return addMock(req, res);
      if (req.method === H.delete) { mocks.clear(); return respond(res, S.ok, { ok: true }); }
    }
    const mockId = pathname.match(MOCK_ROUTE)?.[1];
    if (req.method === H.delete && mockId) return mocks.remove(decodeURIComponent(mockId)) ? respond(res, S.ok, { ok: true }) : fail(res, S.notFound, M.ruleNotFound);
    if (pathname === capture.pathPrefix || pathname.startsWith(`${capture.pathPrefix}/`)) return captureRequest(req, res, url);
    return fail(res, S.notFound, M.notFound);
  }

  const server = http.createServer(async (req, res) => {
    // Not intended as an externally exposed service; reject foreign hosts (DNS rebinding) and cross-site browser requests.
    const host = req.headers.host || '';
    if (!HOST_HEADER.test(host) || !allowedHostnames.has(hostnameOf(host))) return fail(res, S.forbidden, M.onlyLocalhost);
    const origin = req.headers.origin;
    if (origin) {
      try { const u = new URL(origin); if (u.protocol !== SCHEME || !allowedHostnames.has(u.hostname) || u.port !== String(server.address().port)) return fail(res, S.forbidden, M.crossOrigin); }
      catch { return fail(res, S.forbidden, M.invalidOrigin); }
    }
    try { await route(req, res, new URL(req.url || '/', `${SCHEME}//${host}`)); }
    catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error.status || S.serverError;
      // Close the connection on 413 so the client stops streaming the rest of the oversized body.
      respond(res, status, { error: error.status ? error.message : M.internalError }, status === S.payloadTooLarge ? TOO_LARGE_HEADERS : {});
    }
  });
  return { server, events, mocks, config };
}
