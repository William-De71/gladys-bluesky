// -----------------------------------------------------------------------------
// Entry point of the Bluesky external integration (unofficial, not affiliated
// with Bluesky Social PBC).
//
// One Bluesky account (ideally an account of the house), opened with an app
// password through the official XRPC API of the AT Protocol:
//   - communication channel: link a Bluesky account with a code sent in a
//     direct message, then talk to Gladys in direct messages; Gladys'
//     notifications arrive there too;
//   - scene triggers: mentions, replies, quotes, new followers, likes,
//     reposts, direct messages, message not sent;
//   - scene actions: publish a post, send a direct message, delete a post;
//   - three dashboard widgets (account, notifications, direct messages).
// Everything is polled: no webhook, no public URL.
//
// This file only wires the SDK client: the handlers are in src/app.js,
// registered before connect() (the SDK requires it).
//
// Environment variables provided by the Gladys supervisor:
//   GLADYS_HOST_API_URL / GLADYS_INTEGRATION_TOKEN / GLADYS_INTEGRATION_SELECTOR
// The SDK reads them: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const gladys = new GladysIntegration();
const app = createApp(gladys, { logger });

gladys.handleShutdown(() => app.stop());

logger.info(`Starting the Bluesky integration ${version}...`);
try {
  await gladys.connect();
  await app.start();
} catch (error) {
  logger.error('Bluesky: startup failed', error);
  process.exit(1);
}
