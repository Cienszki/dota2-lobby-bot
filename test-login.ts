/**
 * Standalone Steam login test — no Firestore required.
 * Usage:
 *   STEAM_USERNAME=yourbot STEAM_PASSWORD=yourpass npx tsx test-login.ts
 *
 * Or set the vars in .env and just run:
 *   npx tsx test-login.ts
 */

/**
 * Standalone Steam + Dota 2 GC login test.
 *
 * The `dota2@7.0.3` package is built on top of the OLD `steam` npm package
 * (not `steam-user`). It internally creates steam.SteamUser and
 * steam.SteamGameCoordinator from that package. We must use steam.SteamClient
 * for the initial connection, not steam-user.
 *
 * Usage:
 *   STEAM_USERNAME=yourbot STEAM_PASSWORD=yourpass npx tsx test-login.ts
 */

import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');
import * as fs from 'fs';
import * as crypto from 'crypto';

const username = process.env.STEAM_USERNAME;
const password = process.env.STEAM_PASSWORD;

if (!username || !password) {
  console.error('ERROR: Set STEAM_USERNAME and STEAM_PASSWORD in .env');
  process.exit(1);
}

console.log(`[Test] Logging in as: ${username}`);

const steamClient = new Steam.SteamClient();
const steamUser   = new Steam.SteamUser(steamClient);
const dota2Client = new Dota2.Dota2Client(steamClient, true, false);

const logOnDetails: Record<string, unknown> = {
  account_name: username,
  password: password,
};

// Load sentry file if present (avoids Steam Guard email on repeat logins)
try {
  const sentry = fs.readFileSync('./test-sentry');
  if (sentry.length) logOnDetails.sha_sentryfile = sentry;
} catch { /* no sentry yet */ }

steamClient.connect();

steamClient.on('connected', () => {
  console.log('[Steam] Connected to Steam network');
  steamUser.logOn(logOnDetails);
});

steamClient.on('logOnResponse', (resp: { eresult: number }) => {
  if (resp.eresult === Steam.EResult.OK) {
    console.log('[Steam] ✓ Logged in successfully!');
    dota2Client.launch();
    console.log('[Dota2] Launching GC connection...');
  } else {
    console.error(`[Steam] ✗ Login failed: EResult = ${resp.eresult}`);
    process.exit(1);
  }
});

// Handle sentry file for Steam Guard — saves it so future logins skip email code
steamUser.on('updateMachineAuth', (sentry: { bytes: Buffer }, callback: (arg: { sha_file: Buffer }) => void) => {
  const hashed = crypto.createHash('sha1').update(sentry.bytes).digest();
  fs.writeFileSync('./test-sentry', hashed);
  console.log('[Steam] Sentry file saved');
  callback({ sha_file: hashed });
});

steamClient.on('error', (err: Error) => {
  console.error('[Steam] ✗ Error:', err.message ?? err);
  process.exit(1);
});

dota2Client.on('ready', () => {
  console.log('[Dota2] ✓ GC connection established — bot is fully operational!');
  console.log('[Test]  ALL TESTS PASSED. Disconnecting...');
  dota2Client.exit();
  steamClient.disconnect();
  process.exit(0);
});

setTimeout(() => {
  console.error('[Test] ✗ Timeout: could not connect to Dota 2 GC within 60s.');
  process.exit(1);
}, 60_000);

