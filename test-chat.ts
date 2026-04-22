/**
 * Bot Chat Interaction Test
 *
 * Tester: Cienszki (steamId32: 35747920 / steamId64: 76561197996013648)
 *
 * What this test covers:
 *  1. Connect to Steam + Dota 2 GC
 *  2. Create practice lobby (bot in unassigned pool — no kick)
 *  3. Invite Cienszki
 *  4. Wait for Cienszki to join
 *  5. Send welcome message + welcome image URL (Dota2 GC chat is text-only)
 *  6. Respond to !hi command with "Hi [playerName]!"
 *  7. Keep lobby alive until Cienszki leaves or 8-minute timeout
 *  8. Leave lobby
 *
 * Usage:
 *   npx tsx test-chat.ts
 */

import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');

import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Cienszki's Steam identity ─────────────────────────────────────────────
const CIENSZKI_STEAM64 = '76561197996013648';
const CIENSZKI_NAME    = 'Cienszki';

// ─── Lobby config ──────────────────────────────────────────────────────────
const LOBBY_NAME     = 'PD2IH Bot Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// ─── Welcome image URL sent in chat ────────────────────────────────────────
// Dota 2 GC lobby chat is plain text — we send the URL so the player can open it.
// Replace with the actual hosted welcome banner when available.
const WELCOME_IMAGE_URL = 'https://dota2inhouse.pl/welcome-banner.png';

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(tag: string, msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function pass(label: string): void {
  console.log(`\x1b[32m  ✓ PASS: ${label}\x1b[0m`);
}

function fail(label: string, reason: string): void {
  console.log(`\x1b[31m  ✗ FAIL: ${label} — ${reason}\x1b[0m`);
}

function info(msg: string): void {
  console.log(`\x1b[36m  ℹ  ${msg}\x1b[0m`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}\x1b[0m`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  console.log('\x1b[1m\nPD2IH Bot — Chat Interaction Test\x1b[0m');
  console.log(`Bot account: ${username}`);
  console.log(`Tester: ${CIENSZKI_NAME} (Steam64: ${CIENSZKI_STEAM64})`);
  console.log(`Lobby: "${LOBBY_NAME}" / password: ${LOBBY_PASSWORD}`);
  console.log(`Welcome image: ${WELCOME_IMAGE_URL}\n`);

  // ── Step 1: Connect ───────────────────────────────────────────────────
  section('STEP 1 — Connect to Steam + Dota 2 GC');

  const steamClient  = new Steam.SteamClient();
  const steamUser    = new Steam.SteamUser(steamClient);
  const steamFriends = new Steam.SteamFriends(steamClient);
  const dota2        = new Dota2.Dota2Client(steamClient, true, false);

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
    dota2.on('ready', () => { clearTimeout(t); resolve(); });
    steamClient.on('error', (err: Error) => { clearTimeout(t); reject(err); });
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
        game_mode: 2,      // All Pick
        server_region: 3,  // Europe
        visibility: 0,     // Public (visible in Browse, password still required)
        allow_cheats: false,
        fill_with_bots: false,
        allow_spectating: true,
        pause_setting: 1,
        dota_tv_delay: 2,
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

  // Join lobby chat channel (required before sendMessage works)
  const lobbyChannelName = 'Lobby_' + String(dota2.Lobby.lobby_id);
  dota2.joinChat(lobbyChannelName, 3 /* DOTAChannelType_Lobby */);
  log('Chat', `Joined lobby chat channel: ${lobbyChannelName}`);

  await sleep(1500);

  // Move bot to unassigned player pool — not in Radiant slot
  log('Lobby', 'Moving bot to unassigned player pool...');
  dota2.joinPracticeLobbyTeam(1, 4);
  await sleep(500);
  pass('Bot moved to unassigned player pool');
  record('Move bot to unassigned', 'pass');

  // ── Step 3: Invite Cienszki ────────────────────────────────────────────
  section('STEP 3 — Invite Cienszki (GC invite + Steam friend message)');
  log('Invite', `Inviting ${CIENSZKI_NAME} (${CIENSZKI_STEAM64})...`);

  // GC invite — shows as Dota 2 social panel bell notification
  dota2.inviteToLobby(CIENSZKI_STEAM64);
  await sleep(500);

  // Steam friend chat message — shows as a Steam notification with a clickable
  // steam://joinlobby deep link that opens Dota 2 and displays a join dialog.
  // Requires pd2ihbot1 and Cienszki to be Steam friends.
  const lobbyJoinUrl = `steam://joinlobby/570/${String(dota2.Lobby.lobby_id)}`;
  const friendMsg = [
    `[PD2IH Bot] Zaproszenie do lobby!`,
    `Lobby: "${LOBBY_NAME}"  Hasło: ${LOBBY_PASSWORD}`,
    `Kliknij tutaj aby dołączyć: ${lobbyJoinUrl}`,
  ].join('\n');

  steamFriends.sendMessage(CIENSZKI_STEAM64, friendMsg, Steam.EChatEntryType.ChatMsg);
  log('Invite', `Steam friend message sent to ${CIENSZKI_NAME}`);
  log('Invite', `  → ${lobbyJoinUrl}`);

  pass('GC invite + Steam friend message sent');
  record('Invite player', 'pass');
  info(`${CIENSZKI_NAME} will receive a Steam chat notification with a clickable join link.`);
  await sleep(500);

  // ── Step 4: Wait for Cienszki to join ─────────────────────────────────
  section(`STEP 4 — Wait for ${CIENSZKI_NAME} to join`);

  let cienszkiJoined     = false;
  let cienszkiLeft       = false;
  let hiCommandReceived  = false;
  let lobbyUpdateCount   = 0;

  const checkMembers = (lobby: Record<string, unknown>) => {
    lobbyUpdateCount++;
    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;

    // Debug: first 3 updates — print all member IDs
    if (lobbyUpdateCount <= 3) {
      log('LobbyUpdate', `#${lobbyUpdateCount} — ${members.length} member(s)`);
      members.forEach((m, i) => {
        log('LobbyUpdate', `  Member[${i}]: id=${String(m.id)} slot=${m.slot} team=${m.team}`);
      });
    }

    const cienszkiMember = members.find((m) => String(m.id) === CIENSZKI_STEAM64);

    if (cienszkiMember && !cienszkiJoined) {
      cienszkiJoined = true;
      log('LobbyUpdate', `${CIENSZKI_NAME} detected in lobby!`);
    }

    if (!cienszkiMember && cienszkiJoined && !cienszkiLeft) {
      cienszkiLeft = true;
      log('LobbyUpdate', `${CIENSZKI_NAME} left the lobby.`);
    }
  };

  const lobbyUpdateHandler = (lobby: Record<string, unknown>) => checkMembers(lobby);

  dota2.on('practiceLobbyUpdate', lobbyUpdateHandler);

  // Also check the current lobby snapshot immediately — covers the case where
  // the bot reconnected to an existing lobby that already had Cienszki in it.
  if (dota2.Lobby) {
    log('LobbyUpdate', 'Checking current lobby state at startup...');
    checkMembers(dota2.Lobby as Record<string, unknown>);
  }

  // Wait up to 5 min for Cienszki to join
  const joinDeadline = Date.now() + 5 * 60 * 1000;
  while (!cienszkiJoined && Date.now() < joinDeadline) {
    await sleep(1000);
  }

  if (!cienszkiJoined) {
    dota2.removeListener('practiceLobbyUpdate', lobbyUpdateHandler);
    fail(`${CIENSZKI_NAME} did not join within 5 minutes`, 'timeout');
    record('Player join detection', 'fail', 'timeout');
    record('Welcome message + image', 'skip');
    record('!hi command response', 'skip');
  } else {
    pass(`${CIENSZKI_NAME} joined — lobby update event works`);
    record('Player join detection', 'pass');

    // ── Step 5: Welcome message + image URL ──────────────────────────
    section('STEP 5 — Send welcome message + image URL');

    // First message: greet the player
    const welcomeText = `Witaj ${CIENSZKI_NAME}! Cieszę się, że dołączyłeś do lobby PD2IH 🎮 Wpisz !hi żeby przetestować komendy bota!`;
    dota2.sendMessage(welcomeText, lobbyChannelName, 3);
    log('Chat', `Sent welcome text to ${CIENSZKI_NAME}`);

    await sleep(800);

    // Second message: welcome image URL
    // Dota 2 lobby chat is plain text — we send the URL for the player to open
    const imageMsg = `[Baner powitalny] ${WELCOME_IMAGE_URL}`;
    dota2.sendMessage(imageMsg, lobbyChannelName, 3);
    log('Chat', `Sent welcome image URL: ${WELCOME_IMAGE_URL}`);

    pass('Welcome message + image URL sent');
    record('Welcome message + image', 'pass');

    // ── Step 6: Listen for !hi command ────────────────────────────────
    section('STEP 6 — Respond to !hi command');
    info(`Waiting for ${CIENSZKI_NAME} to type !hi in lobby chat...`);
    info('Bot will respond with "Hi [playerName]!"');

    const chatHandler = (
      channel: string,
      senderName: string,
      message: string,
      _chatData: Record<string, unknown>
    ) => {
      log('Chat', `[${channel}] <${senderName}>: ${message}`);

      if (message.trim().toLowerCase() === '!hi') {
        const response = `Hi ${senderName}!`;
        dota2.sendMessage(response, lobbyChannelName, 3);
        log('Chat', `Responded to !hi from ${senderName}: "${response}"`);

        if (!hiCommandReceived) {
          hiCommandReceived = true;
          pass(`!hi command received from ${senderName} — bot responded with "Hi ${senderName}!"`);
          record('!hi command response', 'pass');
        }
      }
    };

    dota2.on('chatMessage', chatHandler);

    // Keep lobby alive: wait up to 8 min total from join, or until Cienszki leaves
    const interactDeadline = Date.now() + 8 * 60 * 1000;
    info(`Lobby stays open. ${CIENSZKI_NAME} can interact. Timeout in 8 minutes.`);
    info('Type !hi in lobby chat to test the command response.');

    while (Date.now() < interactDeadline) {
      await sleep(1000);
      // Exit early once we have the !hi pass AND Cienszki has left
      if (hiCommandReceived && cienszkiLeft) break;
    }

    dota2.removeListener('chatMessage', chatHandler);
    dota2.removeListener('practiceLobbyUpdate', lobbyUpdateHandler);

    if (!hiCommandReceived) {
      fail('!hi command', `${CIENSZKI_NAME} did not send !hi within the timeout`);
      record('!hi command response', 'fail', 'no !hi received');
    }
  }

  // ── Step 7: Leave lobby ───────────────────────────────────────────────
  section('STEP 7 — Leave lobby');

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
    const icon = r.status === 'pass' ? '\x1b[32m✓\x1b[0m'
               : r.status === 'fail' ? '\x1b[31m✗\x1b[0m'
               : '\x1b[33m-\x1b[0m';
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
    if (r.status === 'pass') passed++;
    else if (r.status === 'fail') failed++;
    else skipped++;
  }
  console.log(`\n  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}\n`);

  dota2.exit();
  steamClient.disconnect();
  await sleep(500);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
