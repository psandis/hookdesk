#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const REPLAY_HEADER = 'x-hookdesk-replay';
const DASHBOARD_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'";
const STATIC_FILES = {
  '/': { file: 'ui.html', type: 'text/html; charset=utf-8', headers: { 'x-frame-options': 'DENY', 'content-security-policy': DASHBOARD_CSP } },
  '/ui.js': { file: 'ui.js', type: 'text/javascript; charset=utf-8' },
  '/ui.css': { file: 'ui.css', type: 'text/css; charset=utf-8' },
  '/logo.svg': { file: 'logo.svg', type: 'image/svg+xml' },
};

export function redactHeaders(headers, { sensitiveHeaders, placeholder } = loadConfig().redaction) {
  const sensitive = new Set(sensitiveHeaders);
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitive.has(key.toLowerCase()) ? placeholder : value]));
}

export async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) { const error = new Error(`Payload exceeds ${limit} bytes`); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(value));
}

const summarize = ({ id, timestamp, method, path, bytes, replayOf }) => ({ id, timestamp, method, path, bytes, replayOf });
const hostnameOf = value => { try { return new URL(`http://${value}`).hostname; } catch { return null; } };

export function createApp({ config = loadConfig() } = {}) {
  const { capture, replay, redaction, ui } = config;
  const events = [];
  const allowedHostnames = new Set(config.server.allowedHostnames);
  const listenHost = config.server.host === '::1' ? '[::1]' : config.server.host;
  const notForwarded = new Set([...redaction.sensitiveHeaders, ...replay.excludedHeaders, REPLAY_HEADER]);
  const safeView = event => ({ ...event, headers: redactHeaders(event.headers, redaction) });
  const publicConfig = { host: config.server.host, captureBase: capture.pathPrefix, maxEvents: capture.maxEvents, maxBodyBytes: capture.maxBodyBytes, pollIntervalMs: ui.pollIntervalMs, timelineWindowMs: ui.timelineWindowMs, defaultTheme: ui.defaultTheme, curlExcludedHeaders: ui.curlExcludedHeaders, redactedPlaceholder: redaction.placeholder };

  const handler = async (req, res) => {
    // Not intended as an externally exposed service; reject foreign hosts (DNS rebinding) and cross-site browser requests.
    const host = req.headers.host || '';
    if (!/^[A-Za-z0-9.:[\]-]+$/.test(host) || !allowedHostnames.has(hostnameOf(host))) return respond(res, 403, { error: 'Only localhost is allowed' });
    const origin = req.headers.origin;
    if (origin) {
      try { const u = new URL(origin); if (u.protocol !== 'http:' || !allowedHostnames.has(u.hostname) || u.port !== String(server.address().port)) return respond(res, 403, { error: 'Cross-origin requests are blocked' }); }
      catch { return respond(res, 403, { error: 'Invalid origin' }); }
    }
    const url = new URL(req.url || '/', `http://${host}`);
    try {
      const staticFile = STATIC_FILES[url.pathname];
      if ((req.method === 'GET' || req.method === 'HEAD') && staticFile) {
        const content = await readFile(fileURLToPath(new URL(`./${staticFile.file}`, import.meta.url)));
        res.writeHead(200, { 'content-type': staticFile.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...staticFile.headers });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return respond(res, 200, publicConfig);
      if (req.method === 'GET' && url.pathname === '/api/events') return respond(res, 200, { events: events.map(summarize), count: events.length });
      if (req.method === 'DELETE' && url.pathname === '/api/events') { events.splice(0); return respond(res, 200, { ok: true }); }
      const detailMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        const event = events.find(x => x.id === detailMatch[1]);
        return event ? respond(res, 200, { event: safeView(event) }) : respond(res, 404, { error: 'Event not found' });
      }
      const replayMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/replay$/);
      if (req.method === 'POST' && replayMatch) {
        const source = events.find(x => x.id === replayMatch[1]);
        if (!source) return respond(res, 404, { error: 'Event not found' });
        if (replay.blockedMethods.includes(source.method)) return respond(res, 400, { error: `${source.method} requests cannot be replayed` });
        // Replay stays inside this app. Credentials, hop-by-hop and browser-controlled headers are never forwarded.
        const headers = Object.fromEntries(Object.entries(source.headers).filter(([key]) => !notForwarded.has(key.toLowerCase())));
        headers[REPLAY_HEADER] = source.id;
        const destination = `http://${listenHost}:${server.address().port}${source.path}`;
        let result;
        try {
          result = await fetch(destination, { method: source.method, headers, body: ['GET', 'HEAD'].includes(source.method) ? undefined : source.body, signal: AbortSignal.timeout(replay.timeoutMs) });
          await result.body?.cancel();
        } catch (error) { return respond(res, 502, { error: `Replay failed: ${error.cause?.message || error.message}` }); }
        return respond(res, 200, { ok: true, responseStatus: result.status });
      }
      if (url.pathname === capture.pathPrefix || url.pathname.startsWith(`${capture.pathPrefix}/`)) {
        const body = await readBody(req, capture.maxBodyBytes);
        const event = { id: randomUUID(), timestamp: new Date().toISOString(), method: req.method, path: url.pathname + url.search, headers: { ...req.headers }, body, bytes: Buffer.byteLength(body), replayOf: req.headers[REPLAY_HEADER] || null };
        events.unshift(event);
        if (events.length > capture.maxEvents) events.length = capture.maxEvents;
        return respond(res, 200, { received: true, id: event.id });
      }
      return respond(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || 500;
      // Close the connection on 413 so the client stops streaming the rest of the oversized body.
      return respond(res, status, { error: error.status ? error.message : 'Internal server error' }, status === 413 ? { connection: 'close' } : {});
    }
  };
  const server = http.createServer(handler);
  return { server, events, config };
}

const argValue = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
// Resolve symlinks so the server also starts when launched through an npm bin link.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

if (process.argv[1] && isMain()) {
  const port = argValue('port') ?? process.env.PORT;
  let config;
  try { config = loadConfig({ file: argValue('config'), overrides: port === undefined ? undefined : { server: { port: Number(port) } } }); }
  catch (error) { console.error(error.message); process.exit(1); }
  const { server } = createApp({ config });
  server.on('error', error => { console.error(`Cannot start HookDesk Mini: ${error.message}`); process.exit(1); });
  server.listen(config.server.port, config.server.host, () => {
    const host = config.server.host === '::1' ? '[::1]' : config.server.host;
    const base = `http://${host}:${server.address().port}`;
    console.log(`\n  HookDesk Mini is running`);
    console.log(`  Dashboard: ${base}`);
    console.log(`  Webhook:   ${base}${config.capture.pathPrefix}`);
    console.log(`  Example:   curl -X POST ${base}${config.capture.pathPrefix}/demo -H 'Content-Type: application/json' -d '{"event":"hello"}'\n`);
  });
}
