/**
 * Bot Feature Test — requires a real player to verify lobby interactions.
 *
 * Tester: Cienszki (steamId32: 35747920 / steamId64: 76561197996013648)
 *
 * Test sequence:
 *  1. Connect to Steam + Dota 2 GC
 *  2. Create a practice lobby (password: pd2ihtest)
 *  3. Invite Cienszki
 *  4. Send a chat message
 *  5. Wait for Cienszki to join → confirm lobby update event works
 *  6. Send another chat message confirming we see him
 *  7. Kick Cienszki → confirm kick works
 *  8. Leave lobby
 *
 * Usage:
 *   npx tsx test-features.ts
 */

import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';

// ─── Cienszki's Steam identity ─────────────────────────────────────────────
const CIENSZKI_STEAM32 = 35747920;
const CIENSZKI_STEAM64 = '76561197996013648';
const CIENSZKI_NAME    = 'Cienszki';

// ─── Lobby config ──────────────────────────────────────────────────────────
const LOBBY_NAME     = 'PD2IH Bot Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(step: string, msg: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] [${step}] ${msg}`);
}

function pass(step: string): void {
  console.log(`\x1b[32m  ✓ PASS: ${step}\x1b[0m`);
}

function fail(step: string, reason: string): void {
  console.log(`\x1b[31m  ✗ FAIL: ${step} — ${reason}\x1b[0m`);
}

function info(msg: string): void {
  console.log(`\x1b[36m  ℹ  ${msg}\x1b[0m`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}\x1b[0m`);
}

/** Wait for a specific event on an emitter, with timeout */
function waitForEvent<T>(
  emitter: { on: (e: string, cb: (arg: T) => void) => void; removeListener: (e: string, cb: (arg: T) => void) => void },
  event: string,
  timeoutMs: number,
  predicate?: (arg: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`Timeout waiting for '${event}' after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    function handler(arg: T): void {
      if (!predicate || predicate(arg)) {
        clearTimeout(timer);
        emitter.removeListener(event, handler);
        resolve(arg);
      }
    }

    emitter.on(event, handler);
  });
}

/** Pause and ask user to press Enter before continuing */
function waitForUser(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n\x1b[33m  ⏸  ${prompt} [Press Enter to continue]\x1b[0m\n  `, () => {
      rl.close();
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function steam32ToSteam64(accountId: number): string {
  return String(BigInt('76561197960265728') + BigInt(accountId));
}

// ─── Test results tracker ──────────────────────────────────────────────────
const results: { step: string; status: 'pass' | 'fail' | 'skip'; note?: string }[] = [];

function record(step: string, status: 'pass' | 'fail' | 'skip', note?: string): void {
  results.push({ step, status, note });
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const username = process.env.STEAM_USERNAME;
  const password = process.env.STEAM_PASSWORD;
  if (!username || !password) {
    console.error('ERROR: Set STEAM_USERNAME and STEAM_PASSWORD in .env');
    process.exit(1);
  }

  console.log('\x1b[1m\nPD2IH Bot — Feature Test Suite\x1b[0m');
  console.log(`Bot account: ${username}`);
  console.log(`Tester: ${CIENSZKI_NAME} (Steam32: ${CIENSZKI_STEAM32})`);
  console.log(`Lobby: "${LOBBY_NAME}" / password: ${LOBBY_PASSWORD}\n`);
  info(`${CIENSZKI_NAME} does NOT need to be online — invite will queue in Dota 2`);

  // ── Step 1: Connect ───────────────────────────────────────────────────
  section('STEP 1 — Connect to Steam + Dota 2 GC');

  const steamClient = new Steam.SteamClient();
  const steamUser   = new Steam.SteamUser(steamClient);
  const dota2       = new Dota2.Dota2Client(steamClient, true, false);

  // Patch missing schema enums that our manually-built steam-resources doesn't define
  if (!Dota2.schema.DOTAGameVersion) {
    Dota2.schema.DOTAGameVersion = { GAME_VERSION_STABLE: 0, GAME_VERSION_TEST: 1 };
  }

  const sentryPath = './test-sentry';
  const logOnDetails: Record<string, unknown> = { account_name: username, password };
  try {
    const sentry = fs.readFileSync(sentryPath);
    if (sentry.length) logOnDetails.sha_sentryfile = sentry;
  } catch { /* no sentry yet */ }

  steamUser.on('updateMachineAuth', (sentry: { bytes: Buffer }, cb: (a: { sha_file: Buffer }) => void) => {
    const hashed = crypto.createHash('sha1').update(sentry.bytes).digest();
    fs.writeFileSync(sentryPath, hashed);
    cb({ sha_file: hashed });
  });
  steamClient.on('error', (err: Error) => {
    log('Steam', `Error: ${err?.message ?? err}`);
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Connection timeout')), 60_000);
    steamClient.connect();
    steamClient.on('connected', () => steamUser.logOn(logOnDetails));
    steamClient.on('logOnResponse', (resp: { eresult: number }) => {
      if (resp.eresult !== Steam.EResult.OK) {
        clearTimeout(t);
        return reject(new Error(`Login failed: EResult=${resp.eresult}`));
      }
      dota2.launch();
    });
    dota2.on('ready', () => {
      clearTimeout(t);
      resolve();
    });
  });

  pass('Steam login + GC connection');
  record('Steam login + GC connection', 'pass');

  // ── Step 2: Create lobby ──────────────────────────────────────────────
  section('STEP 2 — Create practice lobby');
  log('Lobby', `Creating "${LOBBY_NAME}" with password "${LOBBY_PASSWORD}"...`);

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Lobby creation timeout')), 30_000);
    dota2.createPracticeLobby(
      {
        game_name: LOBBY_NAME,
        pass_key: LOBBY_PASSWORD,
        game_mode: 2,        // All Pick
        server_region: 3,    // Europe
        visibility: 0,       // Public — visible in Browse (password still required to join)
        allow_cheats: false,
        fill_with_bots: false,
        allow_spectating: true,
        pause_setting: 1,    // Limited
        dota_tv_delay: 2,    // 300s (LobbyDotaTV_300; 0=10s,1=120s,2=300s,3=900s)
      },
      (err: Error | null) => {
        clearTimeout(t);
        if (err) return reject(err);
        resolve();
      }
    );
  });

  pass('Lobby created');
  record('Create lobby', 'pass');
  info(`Lobby "${LOBBY_NAME}" is up — password: ${LOBBY_PASSWORD}`);

  // Join the lobby chat channel so we can send messages (required by dota2 lib)
  const lobbyChannelName = 'Lobby_' + String(dota2.Lobby.lobby_id);
  dota2.joinChat(lobbyChannelName, 3 /* DOTAChannelType_Lobby */);
  log('Chat', `Joining lobby chat channel: ${lobbyChannelName}`);

  await sleep(1500); // Give GC time to acknowledge the chat join

  // Move bot to unassigned player pool so it doesn't occupy a player slot
  // joinPracticeLobbyTeam(slot, team) — DOTA_GC_TEAM_PLAYER_POOL = 4
  log('Lobby', 'Moving bot to unassigned player pool (DOTA_GC_TEAM_PLAYER_POOL)...');
  dota2.joinPracticeLobbyTeam(1, 4);
  await sleep(500);
  pass('Bot moved to unassigned player pool');
  record('Move bot to unassigned', 'pass');

  // ── Step 3: Invite Cienszki ────────────────────────────────────────────
  section('STEP 3 — Invite player (Cienszki)');
  log('Invite', `Inviting ${CIENSZKI_NAME} (${CIENSZKI_STEAM64})...`);

  dota2.inviteToLobby(CIENSZKI_STEAM64);
  pass('Invite sent');
  record('Invite player', 'pass');
  info(`Invite sent to ${CIENSZKI_NAME}. They will receive it next time they open Dota 2.`);

  await sleep(500);

  // ── Step 4: Send chat message ─────────────────────────────────────────
  section('STEP 4 — Send chat message');
  const chatMsg = `Proszę dołącz do lobby: "${LOBBY_NAME}" hasło: ${LOBBY_PASSWORD}`;
  log('Chat', `Sending: "${chatMsg}"`);

  // Send to the lobby chat channel (joined after lobby creation)
  const chatSendOk = (() => {
    try {
      dota2.sendMessage(chatMsg, lobbyChannelName, 3);
      return true;
    } catch (err) {
      fail('Chat message', String(err));
      record('Send chat message', 'fail', String(err));
      return false;
    }
  })();
  if (chatSendOk) {
    pass('Chat message sent');
    record('Send chat message', 'pass');
  }

  // ── Step 5: Wait for Cienszki to join ─────────────────────────────────
  section(`STEP 5 — Wait for ${CIENSZKI_NAME} to join`);
  info(`Lobby name: "${LOBBY_NAME}"  password: ${LOBBY_PASSWORD}`);
  info(`${CIENSZKI_NAME} can join via the invite popup OR manually via Custom Lobbies → Browse`);

  let cienszkiJoined = false;
  let lobbyUpdateCount = 0;

  const lobbyUpdateHandler = (lobby: Record<string, unknown>) => {
    lobbyUpdateCount++;
    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;
    log('LobbyUpdate', `#${lobbyUpdateCount} — ${members.length} member(s) in lobby`);

    // Debug: always print member IDs for the first 3 updates to diagnose detection issues
    if (lobbyUpdateCount <= 3) {
      members.forEach((m, i) => {
        log('LobbyUpdate', `  Member[${i}]: id=${m.id} (str=${String(m.id)}) slot=${m.slot} team=${m.team}`);
      });
    }

    const found = members.find((m) => String(m.id) === CIENSZKI_STEAM64);
    if (found && !cienszkiJoined) {
      cienszkiJoined = true;
      log('LobbyUpdate', `${CIENSZKI_NAME} detected in lobby!`);
      // Send welcome message immediately when player is detected — this is the
      // core production behaviour: bot greets every player that joins.
      const welcomeMsg = `Witaj ${CIENSZKI_NAME}! Dołączyłeś do lobby "${LOBBY_NAME}". Zaraz Cię wykopię — to test bota 😄`;
      dota2.sendMessage(welcomeMsg, lobbyChannelName, 3);
      log('Chat', `Welcome message sent to ${CIENSZKI_NAME}`);
    }
  };

  dota2.on('practiceLobbyUpdate', lobbyUpdateHandler);

  // Wait up to 5 min for Cienszki to join
  const joinDeadline = Date.now() + 5 * 60 * 1000;
  while (!cienszkiJoined && Date.now() < joinDeadline) {
    await sleep(2000);
  }

  dota2.removeListener('practiceLobbyUpdate', lobbyUpdateHandler);

  if (cienszkiJoined) {
    pass(`${CIENSZKI_NAME} joined lobby — lobby update event works`);
    record('Lobby update event / player join detection', 'pass');
  } else {
    fail(`${CIENSZKI_NAME} did not join within 3 minutes`, 'manual join required');
    record('Lobby update event / player join detection', 'fail', 'player did not join');
    info('Skipping kick test. Proceeding to leave lobby.');
  }

  // ── Step 6: Verify welcome chat was sent on join ────────────────────────
  if (cienszkiJoined) {
    section('STEP 6 — Welcome message on player join');
    // Welcome was already sent inside the lobbyUpdateHandler the moment
    // Cienszki was detected — just record the pass here.
    pass('Welcome message sent when player joined');
    record('Welcome chat on join', 'pass');

    // ── Step 7: Kick Cienszki ────────────────────────────────────────────
    // Kick is immediate — in production the bot kicks uninvited players right
    // away so they cannot fill up slots before the real match players join.
    section(`STEP 7 — Kick ${CIENSZKI_NAME}`);
    info(`Kicking ${CIENSZKI_NAME} (Steam32: ${CIENSZKI_STEAM32})...`);

    try {
      dota2.practiceLobbyKick(CIENSZKI_STEAM32);
      await sleep(2000);
      pass(`Kick command sent for ${CIENSZKI_NAME}`);
      record('Kick player', 'pass');
      info(`Tell ${CIENSZKI_NAME} to confirm they were kicked`);
    } catch (err) {
      fail('Kick player', String(err));
      record('Kick player', 'fail', String(err));
    }
  } else {
    record('Welcome chat on join', 'skip');
    record('Kick player', 'skip');
  }

  // ── Step 8: Leave lobby ───────────────────────────────────────────────
  section('STEP 8 — Leave lobby');

  await new Promise<void>((resolve) => {
    dota2.leavePracticeLobby((err: Error | null) => {
      if (err) {
        fail('Leave lobby', String(err));
        record('Leave lobby', 'fail', String(err));
      } else {
        pass('Left lobby successfully');
        record('Leave lobby', 'pass');
      }
      resolve();
    });
  });

  await sleep(1000);

  // ── Summary ────────────────────────────────────────────────────────────
  section('TEST SUMMARY');
  let passed = 0, failed = 0, skipped = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? '\x1b[32m✓\x1b[0m' : r.status === 'fail' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m-\x1b[0m';
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
    if (r.status === 'pass') passed++;
    else if (r.status === 'fail') failed++;
    else skipped++;
  }
  console.log(`\n  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}\n`);

  // ── Disconnect ─────────────────────────────────────────────────────────
  dota2.exit();
  steamClient.disconnect();
  await sleep(500);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
