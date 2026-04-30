/**
 * DotaClient Class End-to-End Test
 *
 * Tests the production DotaClient wrapper (src/dota-client.ts) directly,
 * covering all high-level events and the Phase 2 gaps:
 *   - DotaClient.connect() / createLobby() / setSessionTeams() / invitePlayer()
 *   - 'playerJoined' event fires for Cienszki
 *   - 'chatMessage' does NOT fire for the bot's own messages (self-loop guard)
 *   - 'chatMessage' DOES fire for Cienszki's messages (e.g. !hi command)
 *   - Auto-kick: uninvited player is kicked immediately (manual trigger via console)
 *   - Slot validation: lobbyUpdate includes slotValidation
 *   - leaveLobby()
 *
 * Tester: Cienszki (steamId32: 35747920 / steamId64: 76561197996013648)
 *
 * NOTE: For fully automated testing without a human, use test-multi-bot.ts instead.
 * This file is kept for DotaClient wrapper regression. See docs/TESTING_FLOW.md §3d.
 *
 * Usage:
 *   npx tsx bot-worker/test-dota-client.ts
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// Load .env from the same directory as this file, regardless of CWD
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

import { DotaClient } from './src/dota-client.js';
import type { LobbyPlayerInfo, LobbyChatMessage, TeamSlotValidation } from './src/dota-client.js';
import * as readline from 'readline';

// ─── Cienszki's identity ────────────────────────────────────────────────────
const CIENSZKI_STEAM32 = '35747920';
const CIENSZKI_STEAM64 = '76561197996013648';
const CIENSZKI_NAME    = 'Cienszki';

// ─── Lobby config ──────────────────────────────────────────────────────────
const LOBBY_NAME     = 'PD2IH DotaClient Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(step: string, msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${step}] ${msg}`);
}
function pass(label: string): void { console.log(`\x1b[32m  ✓ PASS: ${label}\x1b[0m`); }
function fail(label: string, reason: string): void { console.log(`\x1b[31m  ✗ FAIL: ${label} — ${reason}\x1b[0m`); }
function info(msg: string): void { console.log(`\x1b[36m  ℹ  ${msg}\x1b[0m`); }
function section(title: string): void {
  console.log(`\n\x1b[1m${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}\x1b[0m`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function waitForUser(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n\x1b[33m  ⏸  ${prompt} [Press Enter]\x1b[0m\n  `, () => { rl.close(); resolve(); });
  });
}
function waitForEvent<T>(
  emitter: { on: (e: string, cb: (arg: T) => void) => void; removeListener: (e: string, cb: (arg: T) => void) => void },
  event: string,
  timeoutMs: number,
  predicate?: (arg: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`Timeout waiting for '${event}' (${timeoutMs / 1000}s)`));
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

// ─── Test results ──────────────────────────────────────────────────────────
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

  console.log('\x1b[1m\nPD2IH Bot — DotaClient Class Test\x1b[0m');
  console.log(`Bot account: ${username}`);
  console.log(`Tester: ${CIENSZKI_NAME} (Steam32: ${CIENSZKI_STEAM32})\n`);

  const client = new DotaClient({ username, password });

  // ── Step 1: connect() ──────────────────────────────────────────────────
  section('STEP 1 — DotaClient.connect()');
  try {
    await client.connect();
    pass('connect() — Steam + GC ready');
    record('connect()', 'pass');
  } catch (err) {
    fail('connect()', String(err));
    record('connect()', 'fail', String(err));
    process.exit(1);
  }

  // ── Step 2: createLobby() ─────────────────────────────────────────────
  section('STEP 2 — DotaClient.createLobby()');
  try {
    await client.createLobby({
      name: LOBBY_NAME,
      password: LOBBY_PASSWORD,
      gameMode: 2,        // All Pick
      serverRegion: 8,    // EU West
      visibility: 0,      // Public
      dotaTvDelay: 120,
      seriesType: 0,
      cheatsEnabled: false,
      fillWithBots: false,
      allowSpectators: true,
      pauseSetting: 1,
    });
    pass('createLobby() — lobby created, bot in unassigned pool, chat joined');
    record('createLobby()', 'pass');
  } catch (err) {
    fail('createLobby()', String(err));
    record('createLobby()', 'fail', String(err));
    await client.disconnect();
    process.exit(1);
  }

  // ── Step 3: setSessionTeams() + invitePlayer() ────────────────────────
  section('STEP 3 — setSessionTeams() + invitePlayer()');

  // Cienszki is "Team A" (just 1 player for testing — normally 5)
  // "Team B" is empty for this test (we're only testing with one real player)
  // Use a known Steam32 for a dummy "Team B slot" so the allowed list works
  const DUMMY_TEAM_B_IDS = ['99999991', '99999992', '99999993', '99999994', '99999995'];
  const CIENSZKI_TEAM_IDS = [CIENSZKI_STEAM32, '99999996', '99999997', '99999998', '99999999'];

  // For a realistic auto-kick test: configure ONLY Cienszki's exact ID as allowed,
  // with dummy IDs filling the rest. Anyone else who joins will be auto-kicked.
  client.setSessionTeams(CIENSZKI_TEAM_IDS, DUMMY_TEAM_B_IDS);
  info(`Session teams configured: Cienszki (${CIENSZKI_STEAM32}) is in Team A`);
  info(`Auto-kick is ACTIVE — anyone not in the invite list will be kicked immediately`);

  // Track lobby updates for slot validation
  let lastSlotValidation: TeamSlotValidation | null = null;
  client.on('lobbyUpdate', (data: { players: LobbyPlayerInfo[]; slotValidation: TeamSlotValidation | null }) => {
    if (data.slotValidation !== null) {
      lastSlotValidation = data.slotValidation;
    }
  });

  await client.invitePlayer(CIENSZKI_STEAM32);
  info(`GC invite sent to Cienszki (${CIENSZKI_STEAM64})`);
  info(`Lobby: "${LOBBY_NAME}" / password: ${LOBBY_PASSWORD}`);
  pass('setSessionTeams() + invitePlayer() called');
  record('setSessionTeams() + invitePlayer()', 'pass');

  // ── Step 4: 'playerJoined' event ──────────────────────────────────────
  section('STEP 4 — Waiting for Cienszki to join (playerJoined event)');
  info(`Cienszki should join the lobby now.`);

  let joinedAccountId = 0;
  try {
    const joinData = await waitForEvent<{ accountId: number; steamId64: string }>(
      client, 'playerJoined', 120_000,
      (d) => d.steamId64 === CIENSZKI_STEAM64
    );
    joinedAccountId = joinData.accountId;
    pass(`playerJoined event — Cienszki detected (accountId=${joinedAccountId})`);
    record('playerJoined event', 'pass', `accountId=${joinedAccountId}`);
  } catch (err) {
    fail('playerJoined event', String(err));
    record('playerJoined event', 'fail', String(err));
    await client.disconnect();
    process.exit(1);
  }

  // ── Step 5: sendChatMessage() + self-loop guard ────────────────────────
  section('STEP 5 — sendChatMessage() + self-loop guard');
  info('Bot sends a welcome message. Checking the chatMessage event does NOT fire for own messages.');

  let ownMessageFired = false;
  const ownMsgGuardListener = (msg: LobbyChatMessage) => {
    if (msg.message.includes('Welcome')) {
      ownMessageFired = true;
    }
  };
  client.on('chatMessage', ownMsgGuardListener);

  await client.sendChatMessage(`Welcome to the lobby, ${CIENSZKI_NAME}! This is the DotaClient class test.`);
  await sleep(2000); // Give time for own-message event to fire (if the guard is broken)

  client.removeListener('chatMessage', ownMsgGuardListener);

  if (!ownMessageFired) {
    pass('Self-loop guard — chatMessage did NOT fire for bot\'s own message');
    record('self-loop guard', 'pass');
  } else {
    fail('Self-loop guard', 'chatMessage fired for bot\'s own message — infinite loop risk!');
    record('self-loop guard', 'fail', 'own message triggered chatMessage event');
  }

  // ── Step 6: 'chatMessage' event for player messages ───────────────────
  section('STEP 6 — chatMessage event for !hi command');
  info(`Ask Cienszki to type "!hi" in the lobby chat.`);

  try {
    const chatData = await waitForEvent<LobbyChatMessage>(
      client, 'chatMessage', 180_000,
      (m) => m.message.trim() === '!hi'
    );
    await client.sendChatMessage(`Hi ${chatData.playerName}!`);
    pass(`chatMessage event — received "!hi" from ${chatData.playerName}, responded`);
    record('chatMessage event (!hi)', 'pass', `from ${chatData.playerName}`);
  } catch (err) {
    fail('chatMessage event (!hi)', String(err));
    record('chatMessage event (!hi)', 'fail', String(err));
  }

  // ── Step 7: Slot validation check ─────────────────────────────────────
  section('STEP 7 — Slot validation (lobbyUpdate includes TeamSlotValidation)');

  if (lastSlotValidation !== null) {
    pass('slotValidation is included in lobbyUpdate events');
    info(`  ready: ${lastSlotValidation.ready}`);
    info(`  Team A present: ${lastSlotValidation.teamAPresent}/5, missing: [${lastSlotValidation.teamAMissingIds.join(', ')}]`);
    info(`  Team B present: ${lastSlotValidation.teamBPresent}/5, missing: [${lastSlotValidation.teamBMissingIds.join(', ')}]`);
    info(`  Team A side: ${lastSlotValidation.teamASide ?? 'none'}, split: ${lastSlotValidation.teamASplit}`);
    info(`  Team B side: ${lastSlotValidation.teamBSide ?? 'none'}, split: ${lastSlotValidation.teamBSplit}`);
    record('slot validation in lobbyUpdate', 'pass', `ready=${lastSlotValidation.ready}`);
  } else {
    // No lobbyUpdate with slotValidation yet — call validateTeamSlots directly
    const validation = client.validateTeamSlots();
    if (validation !== null) {
      pass('validateTeamSlots() returns TeamSlotValidation');
      info(`  ready: ${validation.ready}, teamAPresent: ${validation.teamAPresent}/5`);
      record('slot validation', 'pass', `validateTeamSlots() works`);
    } else {
      fail('slot validation', 'validateTeamSlots() returned null (no teams configured?)');
      record('slot validation', 'fail', 'validateTeamSlots() returned null');
    }
  }

  // ── Step 8: Auto-kick test ─────────────────────────────────────────────
  section('STEP 8 — Auto-kick uninvited player (manual)');
  info(`To test auto-kick: join the lobby with a DIFFERENT Steam account.`);
  info(`The bot should kick that account immediately upon join.`);
  info(`(Cienszki is allowed — he has Steam32 ${CIENSZKI_STEAM32} in the invite list)`);

  let autoKickFired = false;
  client.once('playerKicked', (data: { accountId: number; reason: string }) => {
    autoKickFired = true;
    pass(`playerKicked event — accountId=${data.accountId} reason=${data.reason}`);
    record('auto-kick uninvited', 'pass', `kicked accountId=${data.accountId}`);
  });

  await waitForUser('Join with an UNINVITED account now (or press Enter to skip)');

  if (!autoKickFired) {
    info('Auto-kick not triggered (test skipped)');
    record('auto-kick uninvited', 'skip', 'no uninvited player joined');
  }

  // ── Step 9: leaveLobby() ──────────────────────────────────────────────
  section('STEP 9 — DotaClient.leaveLobby()');
  try {
    await client.leaveLobby();
    pass('leaveLobby() — left lobby successfully');
    record('leaveLobby()', 'pass');
  } catch (err) {
    fail('leaveLobby()', String(err));
    record('leaveLobby()', 'fail', String(err));
  }

  await client.disconnect();

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n\x1b[1m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m  TEST SUMMARY\x1b[0m');
  console.log('═'.repeat(60));
  let passed = 0, failed = 0, skipped = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? '\x1b[32m✓\x1b[0m' : r.status === 'fail' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m-\x1b[0m';
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
    if (r.status === 'pass') passed++;
    else if (r.status === 'fail') failed++;
    else skipped++;
  }
  console.log('─'.repeat(60));
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═'.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
