#!/usr/bin/env node
import { app, messages, format, urlHost } from './loader/fixed.js';
import { loadConfig } from './loader/settings.js';
import { createApp } from './server.js';

const M = messages.cli;
const argValue = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);

const port = argValue('port') ?? process.env.PORT;
let config;
try { config = loadConfig({ file: argValue('config'), overrides: port === undefined ? undefined : { server: { port: Number(port) } } }); }
catch (error) { console.error(error.message); process.exit(1); }

const { server } = createApp({ config });
server.on('error', error => { console.error(format(M.cannotStart, { name: app.name, reason: error.message })); process.exit(1); });
server.listen(config.server.port, config.server.host, () => {
  const base = `${app.scheme}://${urlHost(config.server.host)}:${server.address().port}`;
  const webhook = `${base}${config.capture.pathPrefix}`;
  const count = config.mocks.rules.length;
  const mocks = count ? format(count === 1 ? M.mocksOne : M.mocksMany, { count }) : format(M.mocksNone, { status: app.defaultResponse.status, body: JSON.stringify(app.defaultResponse.body) });
  const command = format(M.exampleCommand, { url: `${webhook}${app.cli.examplePath}`, contentType: app.cli.exampleContentType, body: app.cli.exampleBody });
  const lines = [format(M.running, { name: app.name }), format(M.dashboard, { url: base }), format(M.webhook, { url: webhook }), mocks, format(M.example, { command })];
  console.log(`\n${lines.map(line => `  ${line}`).join('\n')}\n`);
});
