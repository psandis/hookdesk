<img src="assets/wordmark.svg" alt="HookDesk Mini" width="290" height="64">

[![npm version](https://img.shields.io/npm/v/hookdesk.svg)](https://www.npmjs.com/package/hookdesk)
[![node](https://img.shields.io/badge/node-%3E%3D26-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Local-only webhook inspector and test bench. Point any webhook or HTTP client at `http://127.0.0.1:4317/hook/...` and watch requests land in a live browser dashboard, where you can inspect headers and bodies, copy them as cURL, and replay them. Mock rules decide what the sender gets back, and a small API lets automated tests wait for a webhook and check exactly what arrived. No account, no cloud, no database, and no npm dependencies. The npm package and the command are both **hookdesk**.

## What It Does

- captures any HTTP method on any path under `/hook/`
- mock responses: per path and method, choose the status, headers, body, and delay the sender receives
- records the response each request got, so you can verify how the sender was answered
- test API: filter captured requests, wait for a matching request, and export a run as JSON
- live activity timeline: one spike per request, colored by method, taller for bigger bodies
- live stats: requests in memory, requests in the last minute, time since the last request, total body size
- request table, newest first, with method, path, response status, size, and age
- request detail with tabs: syntax-highlighted JSON body, headers, the response sent, and a ready cURL command
- replays a captured request to the local inbox, never to its original sender
- redacts credential headers (`authorization`, `cookie`, `x-api-key`, and more) in the dashboard, API, and export
- keyboard navigation: `j` / `k` to move, `r` to replay, `c` to copy as cURL
- dark, light, or auto theme, remembered per browser
- config-driven: every setting, limit, route, status code, header name, text, and UI constant lives in JSON files under `config/`
- binds to `127.0.0.1` only, with `Host` and `Origin` checks

## Requirements

- Node.js 26+
- macOS, Linux, or Windows

## Install

```bash
npm install -g hookdesk
```

Or run it once without installing:

```bash
npx hookdesk
```

### From source

```bash
git clone https://github.com/psandis/hookdesk.git
cd hookdesk
npm link
hookdesk
```

There is nothing to install or build: hookdesk has no dependencies. Without linking, use `npm start` in place of `hookdesk`.

## Quick Start

Start the dashboard:

```bash
hookdesk
```

```text
  HookDesk Mini is running
  Dashboard: http://127.0.0.1:4317
  Webhook:   http://127.0.0.1:4317/hook
  Mocks:     none, every request gets 200 {"received":true}
  Example:   curl -X POST http://127.0.0.1:4317/hook/demo -H 'Content-Type: application/json' -d '{"event":"hello"}'
```

Open the dashboard URL in a browser, then send a test request from another terminal.

macOS / Linux:

```bash
curl -X POST http://127.0.0.1:4317/hook/order.created \
  -H 'Content-Type: application/json' \
  -d '{"event":"order.created","orderId":123,"amount":49.90}'
```

Windows (PowerShell):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4317/hook/order.created `
  -ContentType 'application/json' `
  -Body '{"event":"order.created","orderId":123,"amount":49.90}'
```

The request appears in the dashboard within the poll interval (1.5 seconds by default). Stop the server with `Ctrl+C`.

## Mock Responses

Without rules, every captured request gets `200 {"received":true,"id":"<event id>"}`. A mock rule changes that for matching requests, so you can test how the sender handles errors, retries, and slow endpoints.

| Field | Default | Description |
|---|---|---|
| `id` | generated | Name of the rule. Rules from the config file without an id get `config-1`, `config-2`, ... |
| `method` | `*` | HTTP method, or `*` for any |
| `path` | required | Exact path such as `/hook/payments`, or a prefix ending in `/*` such as `/hook/orders/*`. Must be under `capture.pathPrefix`. The query string is ignored. |
| `status` | `200` | Response status, 200..599 |
| `headers` | none | Response headers as an object of strings. `content-length`, `transfer-encoding`, and other framing headers are set by the server. |
| `body` | none | A string is sent as is (`text/plain`); any other JSON value is sent as JSON (`application/json`), unless `headers` sets `content-type` |
| `delayMs` | `0` | Wait before answering, up to `mocks.maxDelayMs` |

The defaults come from `mocks.ruleDefaults` in `config/app.json`, and the allowed status range from `config/limits.json`. The first matching rule answers. Rules added through the API or the dashboard go first, so a test can override a rule from the config file.

Add a rule at runtime:

```bash
curl -s -X POST http://127.0.0.1:4317/api/mocks \
  -H 'Content-Type: application/json' \
  -d '{"id":"payments-down","method":"POST","path":"/hook/payments","status":503,"headers":{"Retry-After":"30"},"body":{"error":"service unavailable"},"delayMs":2000}'
```

```text
{"rule":{"id":"payments-down","method":"POST","path":"/hook/payments","status":503,"headers":{"retry-after":"30","content-type":"application/json; charset=utf-8"},"body":"{\"error\":\"service unavailable\"}","delayMs":2000}}
```

The sender now gets, after two seconds:

```text
HTTP/1.1 503 Service Unavailable
cache-control: no-store
retry-after: 30
content-type: application/json; charset=utf-8
x-content-type-options: nosniff
content-security-policy: sandbox
x-hookdesk-event-id: c7ce5dfe-c629-461b-a00a-5d100408e514

{"error":"service unavailable"}
```

Every capture response carries `x-hookdesk-event-id`, the id of the stored request.

Rules can also live in a config file, so they are active from startup:

```json
{
  "mocks": {
    "rules": [
      { "method": "POST", "path": "/hook/payments", "status": 503, "delayMs": 2000 },
      { "path": "/hook/slow/*", "delayMs": 8000 }
    ]
  }
}
```

In the dashboard, open **Mock responses** under the command bar to see, add, and remove rules.

## Verifying Webhooks in Tests

The API lets a test suite check that a webhook was sent, and what it contained, without reading the dashboard.

1. Optionally add mock rules for the scenario.
2. Note the current time.
3. Trigger the code that sends the webhook.
4. Wait for the request with `/api/events/wait` and assert on it.

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# ... trigger your app here ...
curl -s "http://127.0.0.1:4317/api/events/wait?method=POST&path=/hook/orders/*&since=$SINCE&timeout=5000"
```

```text
{
  "event": {
    "id": "00fd2eee-b7ea-458b-ac5c-0bfa1bfa1a4a",
    "timestamp": "2026-11-21T15:35:33.831Z",
    "method": "POST",
    "path": "/hook/orders/123",
    "headers": {
      "host": "127.0.0.1:4317",
      "user-agent": "curl/8.7.1",
      "accept": "*/*",
      "content-type": "application/json",
      "content-length": "25"
    },
    "body": "{\"event\":\"order.created\"}",
    "bytes": 25,
    "replayOf": null,
    "response": {
      "status": 200,
      "mockId": null,
      "mockPath": null,
      "delayMs": 0
    }
  }
}
```

`wait` returns the oldest matching request at once if one is already stored, otherwise it holds the connection until one arrives. With no match before the timeout it answers `408`:

```text
{"error":"No matching request within 1000 ms"}
```

The same filters work on the list and the export:

| Parameter | Example | Matches |
|---|---|---|
| `method` | `POST` | HTTP method, any case |
| `path` | `/hook/orders/*` | Exact path, or a prefix ending in `/*` |
| `since` | `2026-11-21T15:35:00.000Z` | Requests at or after this ISO 8601 time |
| `timeout` | `5000` | `wait` only: milliseconds, up to `wait.maxTimeoutMs` |

```bash
curl -s "http://127.0.0.1:4317/api/events?path=/hook/payments"
```

```text
{"events":[{"id":"c7ce5dfe-c629-461b-a00a-5d100408e514","timestamp":"2026-11-21T15:35:30.807Z","method":"POST","path":"/hook/payments","bytes":16,"replayOf":null,"status":503,"mockId":"payments-down"}],"count":1,"total":2}
```

`GET /api/events/export` downloads the matching requests with redacted headers, bodies, and responses, plus the active mock rules, as evidence of a test run. The dashboard **Export** button downloads everything.

To start each test from a clean state, call `DELETE /api/events` and `DELETE /api/mocks`.

## Dashboard

### Header

- **Logo**: brand mark on the left
- **version / host / buffer / storage**: running version, bind address, how many requests are kept, and where (memory)
- **Live**: whether the dashboard can reach the local server; turns to **Offline** when it cannot
- **Theme**: `Auto` follows the operating system, `Light` and `Dark` force a theme. The choice is remembered in the browser.

### Stats

| Tile | Shows |
|---|---|
| Captured | Requests held in memory |
| Last 1m | Requests received in the last minute (`ui.rateWindowMs` in `config/app.json`) |
| Last hit | Time since the newest request |
| In memory | Total size of all request bodies. Hover for the exact byte count. |

### Activity timeline

The last 5 minutes (`ui.timelineWindowMs`) of traffic. Each spike is one request: its color is the HTTP method (see the legend), its height grows with the body size on a log scale. Hover a spike to preview the request, click it to open it. New requests pulse when they arrive.

### Send a test

The command bar shows a ready `curl` command for your endpoint.

| Button | Action |
|---|---|
| Copy endpoint | Copies the base URL, for pasting into a webhook provider or your app |
| Copy curl | Copies the test command |
| Export | Downloads all captured requests and their responses as JSON |
| Refresh | Reloads the request list immediately |
| Clear | Deletes all captured requests, after a confirmation |

### Mock responses

A collapsible panel under the command bar. It lists the active rules (method, path, status, delay, id) and has a form to add a rule. **Remove** deletes one rule, **Remove all rules** deletes every rule after a confirmation.

### Requests

A table of captured requests, newest first.

| Column | Description |
|---|---|
| Method | HTTP method, colored as in the timeline legend |
| Path | Path and query string. Replayed requests are marked `replay`, requests answered by a mock rule `mock`. |
| Status | The status the sender received. 400 and above are shown in red. |
| Size | Body size. Hover for the exact byte count. |
| Age | Time since the request arrived, updated every second |

### Request detail

Clicking a row opens the request with its path, method, received date and time, size, and short ID.

| Tab | Content |
|---|---|
| Body | The body as received. JSON is pretty-printed and syntax-highlighted with line numbers. |
| Headers | All headers. Sensitive values show as `[REDACTED]`. |
| Response | The status sent, the mock rule that answered (or the default response), and the delay |
| cURL | A command that re-sends the request, without redacted headers |

**Replay locally** re-sends the request to this hookdesk inbox, never to the original sender. Credential headers and hop-by-hop headers are stripped; the body is re-sent unchanged. `CONNECT`, `TRACE`, and `TRACK` requests cannot be replayed. A replay to a path with a mock delay longer than `replay.timeoutMs` fails with `502`.

### Keyboard

| Key | Action |
|---|---|
| `j` or `Down` | Next request |
| `k` or `Up` | Previous request |
| `r` | Replay the selected request |
| `c` | Copy the selected request as cURL |

The keys are set in `ui.keys` in `config/app.json`; the hints in the dashboard follow them.

## Configuration

All values live in JSON files under [`config/`](config/). The `.js` files under `src/` contain only logic and read every value from these files.

| File | Contents | Overridable |
|---|---|---|
| [`config/default.json`](config/default.json) | Settings: server, capture, replay, redaction, mocks, wait, ui | Yes, with `--config` |
| [`config/limits.json`](config/limits.json) | Validation bounds and fixed lists: allowed ranges, patterns, loopback hosts, themes, reserved headers, rule keys | No |
| [`config/app.json`](config/app.json) | Product name, API routes and query parameter names, HTTP methods and status codes, header names, content types, security headers, default response, export file name, static files, dashboard constants (keys, timings, timeline drawing) | No |
| [`config/messages.json`](config/messages.json) | Every text shown by the CLI, the API errors, config validation, and the dashboard | No |

The dashboard page `src/ui/index.html` is a template: the server fills its `{{...}}` placeholders from `messages.json` and `app.json` before sending it, and the dashboard script gets the rest through `/api/config`. Changing a text or a route in JSON changes it everywhere.

To change settings, create a JSON file with only the keys you want to override and pass it with `--config`:

```json
{
  "capture": { "maxEvents": 50, "pathPrefix": "/inbox" },
  "redaction": { "sensitiveHeaders": ["authorization", "cookie", "x-signature"] },
  "ui": { "defaultTheme": "light" }
}
```

```bash
hookdesk --config=./hookdesk.config.json
```

Values are merged in this order, later ones win:

1. built-in defaults (`config/default.json`)
2. the file passed with `--config=<path>`
3. the `PORT` environment variable
4. the `--port=<number>` flag

Changing the port:

```bash
# macOS / Linux
hookdesk --port=4343
PORT=4343 hookdesk
```

```powershell
# Windows (PowerShell)
hookdesk --port=4343
$env:PORT=4343; hookdesk
```

### Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `server.host` | string | `127.0.0.1` | Bind address. Must be loopback: `127.0.0.1`, `localhost`, or `::1` |
| `server.port` | integer | `4317` | Port. `0` picks a free port |
| `server.allowedHostnames` | string[] | `["127.0.0.1", "localhost"]` | Accepted `Host` and `Origin` hostnames. Loopback names only |
| `capture.pathPrefix` | string | `/hook` | Path under which requests are captured |
| `capture.maxBodyBytes` | integer | `1048576` | Body size limit (1 MiB). Larger bodies get HTTP 413 |
| `capture.maxEvents` | integer | `200` | Number of requests kept in memory |
| `replay.timeoutMs` | integer | `5000` | Replay request timeout |
| `replay.blockedMethods` | string[] | `["CONNECT", "TRACE", "TRACK"]` | Methods that cannot be replayed |
| `replay.excludedHeaders` | string[] | hop-by-hop and browser headers | Headers dropped on replay. Sensitive headers are always dropped too |
| `redaction.sensitiveHeaders` | string[] | `authorization`, `cookie`, `x-api-key`, ... | Headers shown as the placeholder in the dashboard, API, and export |
| `redaction.placeholder` | string | `[REDACTED]` | Replacement text for redacted values |
| `mocks.rules` | object[] | `[]` | Mock rules active at startup, see [Mock Responses](#mock-responses) |
| `mocks.maxRules` | integer | `100` | Maximum number of rules |
| `mocks.maxDelayMs` | integer | `30000` | Maximum `delayMs` of a rule |
| `wait.defaultTimeoutMs` | integer | `10000` | `wait` timeout when the request does not set one |
| `wait.maxTimeoutMs` | integer | `60000` | Largest `timeout` a `wait` request may ask for |
| `ui.pollIntervalMs` | integer | `1500` | Dashboard refresh interval |
| `ui.timelineWindowMs` | integer | `300000` | Time span of the activity timeline (5 minutes) |
| `ui.defaultTheme` | string | `auto` | `auto`, `light`, or `dark`. Each viewer can still switch in the header |
| `ui.curlExcludedHeaders` | string[] | `host`, `content-length`, ... | Headers left out of "Copy as cURL" |

### Validation

The configuration is validated at startup against `config/limits.json`. Unknown keys (usually typos) and invalid values stop the server with exit code 1:

```text
$ hookdesk --config=./hookdesk.config.json
Unknown config key "capture.maxEvent"

$ hookdesk --port=abc
Invalid configuration:
  - server.port must be an integer 0..65535
```

## Storage

hookdesk writes nothing to disk. Captured requests and runtime mock rules are held only in memory (the last `capture.maxEvents` requests, default 200) and are erased when the server stops or restarts. The only file it reads besides its own is the optional `--config` file. The theme choice is kept in the browser's `localStorage`.

## API

hookdesk exposes a local REST API on the same port as the dashboard. All endpoints return JSON.

| Method | Path | Description |
|---|---|---|
| any | `/hook`, `/hook/*` | Capture a request; answered by the first matching mock rule or the default response |
| `GET` | `/api/events` | List captured requests (summaries with response status, no headers or body). Accepts `method`, `path`, `since` |
| `GET` | `/api/events/wait` | Wait for a matching request. Accepts `method`, `path`, `since`, `timeout`. `408` on timeout |
| `GET` | `/api/events/export` | Download matching requests with redacted headers, bodies, responses, and the active mock rules |
| `GET` | `/api/events/:id` | One request with redacted headers, the body, and the response sent |
| `POST` | `/api/events/:id/replay` | Replay a request to the local inbox |
| `DELETE` | `/api/events` | Clear all captured requests |
| `GET` | `/api/mocks` | List mock rules in match order |
| `POST` | `/api/mocks` | Add a rule (JSON body, `Content-Type: application/json`). `201`, `400` invalid, `409` duplicate id, `415` wrong content type |
| `DELETE` | `/api/mocks/:id` | Remove one rule |
| `DELETE` | `/api/mocks` | Remove all rules |
| `GET` | `/api/config` | Settings the dashboard uses |

## Security

- Binds to loopback only. `Host` and `Origin` checks block DNS rebinding and cross-site requests from web pages, including adding mock rules.
- `POST /api/mocks` requires `Content-Type: application/json`, which a plain HTML form cannot send.
- The dashboard is served with a strict Content Security Policy and no inline scripts or styles.
- Mock responses are served with `Content-Security-Policy: sandbox`, so a mocked HTML body cannot run scripts on the dashboard origin.
- Sensitive headers are redacted in the dashboard, API, and export. **Bodies are not redacted**, so do not send production credentials or personal data to it.
- hookdesk is not a tunnel. To receive webhooks from an external provider, use a trusted tunnel separately.
- Bodies are stored as UTF-8 text; binary payloads are not supported yet.

## Testing

```bash
npm test
```

Current bar:

- 53 tests across config loading, mock rules, the event store, and the HTTP server, using the built-in Node.js test runner
- includes HEAD requests to mocked paths, a cancelled `wait`, IPv6 loopback (`::1`), and a check that the served dashboard has no unfilled template placeholders
- integration tests run a real HTTP server on port 0
- expected values are read from the JSON files under `config/`, so changing a setting does not break tests; only the security requirements (loopback binding, `authorization` redaction, blocked replay methods) are fixed values
- the `hookdesk` command is tested by launching it through a symlink, the way `npm install -g` runs it

## Tech Stack

| Tool | Purpose |
|---|---|
| Node.js 26+ | Runtime |
| node:http | HTTP server, no framework |
| Vanilla JS / HTML / CSS | Dashboard, no frontend framework, no build step |
| Canvas 2D | Activity timeline |
| node:test | Testing |

## File Structure

```text
hookdesk/
├── assets/
│   └── wordmark.svg        README wordmark
├── config/
│   ├── default.json        settings, overridable with --config
│   ├── limits.json         validation bounds and fixed lists
│   ├── app.json            routes, status codes, headers, security policies, UI constants
│   └── messages.json       every text the CLI, API, and dashboard show
├── src/
│   ├── cli.js              the hookdesk command: arguments, startup output
│   ├── server.js           HTTP routing and responses
│   ├── loader/
│   │   ├── settings.js     reads, merges, and validates default.json and --config
│   │   └── fixed.js        reads limits.json, app.json, and messages.json
│   ├── mocks/
│   │   └── rules.js        mock rule validation, matching, and the live rule list
│   ├── store/
│   │   └── events.js       in-memory request store, filters, and wait
│   └── ui/
│       ├── index.html      dashboard markup template, filled from config
│       ├── ui.css          dashboard styles and themes
│       ├── ui.js           dashboard logic and timeline
│       └── logo.svg        logo and favicon
├── tests/
│   ├── config.test.js
│   ├── events.test.js
│   ├── mocks.test.js
│   └── server.test.js
├── package.json
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Next Steps

1. Request search by body content
2. Import of exported runs
3. Binary payload support

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Related

- [wiremonitor](https://github.com/psandis/wiremonitor): Network traffic web dashboard
- [portmind](https://github.com/psandis/portmind): Scan listening ports and remember what normally runs where
- [mydevkit](https://github.com/psandis/mydevkit): Everyday developer tools in one CLI
- [nscout](https://github.com/psandis/nscout): Scout a name across npm, GitHub, PyPI, and domain registries

## License

See [MIT](LICENSE)
