# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-21

### Added

- Mock responses. A rule sets the status, headers, body, and delay that matching requests get back, matched by method (or `*`) and by exact path or a `/*` prefix. Rules come from `mocks.rules` in the config and from the new `/api/mocks` endpoint (`GET`, `POST`, `DELETE`, `DELETE /api/mocks/:id`); the first match answers and runtime rules go first. Without a matching rule the response stays `200 {"received":true,"id":...}`. This makes it possible to test how a sender handles errors, retries, and slow endpoints.
- Each captured request records the response it got (`response.status`, `mockId`, `mockPath`, `delayMs`), shown in the list, the detail view, and the API, so a test run can be verified afterwards.
- Every capture response carries an `x-hookdesk-event-id` header with the id of the stored request.
- Filters on `GET /api/events`: `method`, `path` (exact or `/*` prefix), and `since` (ISO 8601). The response adds `total`, the number of stored requests before filtering.
- `GET /api/events/wait`: returns the oldest matching request at once, or holds the connection until one arrives, or answers `408` after `timeout`. Lets automated tests assert that a webhook was sent.
- `GET /api/events/export`: downloads the matching requests with redacted headers, bodies, responses, and the active mock rules as a JSON file.
- Dashboard: a Mock responses panel to list, add, and remove rules; a Status column and a `mock` marker in the request list; a Response tab in the request detail; an Export button; the running version in the header.
- Settings `mocks.rules`, `mocks.maxRules`, `mocks.maxDelayMs`, `wait.defaultTimeoutMs`, and `wait.maxTimeoutMs`.
- Fully config-driven. `config/limits.json` holds every validation bound, pattern, and fixed list; `config/app.json` holds the product name, API routes and query parameter names, HTTP methods and status codes, header names, content types, security headers, default response, export file name, static file list, and dashboard constants (keys, timings, timeline drawing); `config/messages.json` holds every text the CLI, API errors, config validation, and dashboard show. These values were previously hardcoded in the `.js` and `.html` files. The `.js` files now contain only logic.
- The dashboard page is a template that the server fills from `messages.json` and `app.json`, so a text, route, or key changed in JSON appears in the dashboard without code changes.
- Tests for mock rules (`tests/mocks.test.js`), the event store (`tests/events.test.js`), the new config sections, every new endpoint, HEAD requests to mocked paths, a cancelled `wait`, IPv6 loopback, headers a mock rule cannot override, and the filled dashboard template: 53 tests in total, up from 30.
- `CHANGELOG.md`.

### Changed

- Minimum Node.js version raised from 20 to 26 (`engines.node` is now `>=26`). Node.js 20 reached end of life on 2026-04-30; Node.js 26 is the current Active LTS line, supported until 2029-04-30. hookdesk has no npm dependencies, so the Node.js runtime is the only versioned component it relies on.
- Source split by responsibility: `src/cli.js` is the `hookdesk` command (the `bin` entry), `src/server.js` only routes HTTP, `src/loader/` reads and validates the JSON files, `src/mocks/rules.js` handles mock rules, `src/store/events.js` holds requests and waiters, and the dashboard files moved to `src/ui/` (`ui.html` is now `index.html`). The README wordmark moved to `assets/` and is no longer shipped in the npm package.
- Mock response bodies are served with `Content-Security-Policy: sandbox`, so a mocked HTML page cannot run scripts on the dashboard origin.
- Config validation messages for ranges now name the allowed range from `config/limits.json`, for example `server.port must be an integer 0..65535`. List settings report `<key> must be a list of names`.
- The "Last 60 s" stat tile is now labeled from `ui.rateWindowMs` ("Last 1m" by default).
- On narrow screens the command bar buttons wrap instead of running past the right edge.
- README: mock responses, verifying webhooks in tests, the new API endpoints and settings, the four config files, Node.js 26+, file structure, and a changelog section.
- Verified on Node.js 26.13.1: all 53 tests pass; the packed npm tarball installs, starts through the `hookdesk` command, and passes an end-to-end run of every endpoint; a headless Chrome run clicks through the dashboard (mock form, tabs, keyboard keys, replay, copy, export, themes, remove and clear with confirmation, offline and reconnect, 390 px phone width) with 43 of 43 checks passing; every README example was run against a live server and its output copied as is.

## [0.1.0] - 2026-10-18

### Added

- Local-only webhook inspector: captures any HTTP method on any path under `/hook/` and keeps the last 200 requests in memory. Nothing is written to disk.
- Live browser dashboard: activity timeline (one spike per request, colored by method, height by body size), stats tiles, request table, and request detail with Body, Headers, and cURL tabs.
- Replay of a captured request to the local inbox only, never to the original sender. Credential and hop-by-hop headers are stripped on replay; `CONNECT`, `TRACE`, and `TRACK` cannot be replayed.
- Redaction of credential headers (`authorization`, `cookie`, `x-api-key`, and more) in the dashboard and API.
- Keyboard navigation: `j` / `k` to move, `r` to replay, `c` to copy as cURL.
- Dark, light, and auto themes, remembered per browser.
- Local REST API: `/api/events`, `/api/events/:id`, `/api/events/:id/replay`, `DELETE /api/events`, and `/api/config`.
- Configuration through `config/default.json`, overridable with `--config=<path>`, the `PORT` environment variable, and `--port=<number>`. Unknown keys and invalid values stop the server at startup with exit code 1.
- Security: binds to loopback only, `Host` and `Origin` checks against DNS rebinding and cross-site requests, strict Content Security Policy on the dashboard, 1 MiB body limit (HTTP 413).
- No npm dependencies: Node.js built-in modules only.
- 30 tests with the built-in Node.js test runner, including integration tests against a real HTTP server and a launch through an npm bin symlink.

[0.2.0]: https://github.com/psandis/hookdesk/compare/c0c7632...v0.2.0
[0.1.0]: https://github.com/psandis/hookdesk/commit/c0c7632
