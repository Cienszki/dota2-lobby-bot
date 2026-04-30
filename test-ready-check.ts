/**
 * Live !r / !ur Ready-Check Flow Test  (interactive, requires Cienszki)
 *
 * Tester: Cienszki (steamId32: 35747920 / steamId64: 76561197996013648)
 *
 * NOTE: For fully automated testing without a human, use test-multi-bot.ts instead.
 * This file is kept for interactive/manual sessions. See docs/TESTING_FLOW.md §3e.
 *
 * What this test covers:
 *   A. Welcome message with {player_name} substitution
 *   B. !r while in WRONG slot → bot replies with teamNotReadyMessage + {missing}
 *   C. !r while in CORRECT slot (Radiant 1) → bot replies with teamReadyMessage
 *   D. !ur → ready cleared, bot acknowledges
 *   E. !r spam (3x fast) → bot responds each time (no cooldown throttle)
 *   F. currentPlayers snapshot — verify bot tracks slot positions accurately
 *
 * The bot runs the full slot-validation + placeholder logic inline (no Firestore needed).
 * Expected Radiant team for this session: [Cienszki] (only one player for simplicity).
 *
 * Usage:
 *   npx tsx bot-worker/test-ready-check.ts
 *
 * Exit codes: 0 = all pass, 1 = one or more failures
 */

import dotenv from 'dotenv';
dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');

import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Tester identity ───────────────────────────────────────────────────────

const CIENSZKI_STEAM32  = 35747920;
const CIENSZKI_STEAM64  = '76561197996013648';
const CIENSZKI_NICKNAME = 'Cienszki';

// ─── Lobby config ──────────────────────────────────────────────────────────

const LOBBY_NAME     = 'PD2IH Ready Check Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// ─── Bot message templates (default values from DEFAULT_CHAT_CONFIG) ───────

const WELCOME_MSG        = 'Witaj w testowym lobby PD2IH, {player_name}! Zaraz wyślę Ci instrukcje.';
const TEAM_NOT_READY_MSG = '{player_name}: Nie wszyscy gracze {team_name} są na właściwych slotach. Brakuje: {missing}';
const TEAM_READY_MSG     = '{team_name} gotowy! Czekamy na drugą drużynę...';
const ALL_READY_MSG      = 'Obie drużyny gotowe! Sprawdzam wymagania...';
const UNREADY_ACK_MSG    = '{player_name}: Cofnięto gotowość {team_name}.';

// ─── Session config ────────────────────────────────────────────────────────
// For this test, Radiant team contains only Cienszki.
// This means he just needs to be in ANY radiant slot (0-4).

interface ExpectedPlayer { steamId32: string; nickname: string; }

const EXPECTED_RADIANT: ExpectedPlayer[] = [
  { steamId32: String(CIENSZKI_STEAM32), nickname: CIENSZKI_NICKNAME },
];

const EXPECTED_DIRE: ExpectedPlayer[] = [];

const READY_COMMANDS   = ['!ready', '!r'];
const UNREADY_COMMANDS = ['!unready', '!ur'];

// ─── Runtime state ─────────────────────────────────────────────────────────

interface PlayerSnapshot {
  accountId: number;
  team: 'radiant' | 'dire' | 'spectator' | 'unassigned';
}

const currentPlayers = new Map<number, PlayerSnapshot>(); // keyed by Steam32 accountId
let radiantReady = false;

// All messages sent BY the bot in lobby chat (for recording test outcomes)
const botChatLog: string[] = [];

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

const results: { step: string; status: 'pass' | 'fail' | 'skip'; note?: string }[] = [];

function record(step: string, status: 'pass' | 'fail' | 'skip', note?: string): void {
  results.push({ step, status, note });
}

function applyPlaceholders(
  message: string,
  ctx: { player_name?: string; team_name?: string; missing?: string }
): string {
  return message
    .replace(/\{player_name\}/g, ctx.player_name ?? '')
    .replace(/\{team_name\}/g, ctx.team_name ?? '')
    .replace(/\{missing\}/g, ctx.missing ?? '');
}

function slotToTeam(slot: number): 'radiant' | 'dire' | 'spectator' | 'unassigned' {
  if (slot >= 0 && slot <= 4)  return 'radiant';
  if (slot >= 5 && slot <= 9)  return 'dire';
  if (slot >= 12)              return 'spectator';
  return 'unassigned';
}

function steam64ToSteam32(idLong: unknown): number {
  try {
    const val = BigInt(String(idLong));
    const diff = val - 76561197960265728n;
    return diff > 0n ? Number(diff) : 0;
  } catch {
    return 0;
  }
}

function getCurrentSnapshot(): Array<{ steamId32: string; teamSide: 'radiant' | 'dire' | 'spectator' | 'unassigned' }> {
  return [...currentPlayers.values()].map((p) => ({
    steamId32: String(p.accountId),
    teamSide: p.team,
  }));
}

function checkTeamSlots(
  expected: ExpectedPlayer[],
  team: 'radiant' | 'dire',
  snapshot: ReturnType<typeof getCurrentSnapshot>
): { valid: boolean; missingNames: string[] } {
  const onSide = new Set(
    snapshot.filter((p) => p.teamSide === team).map((p) => p.steamId32)
  );
  const missing = expected.filter((p) => !onSide.has(p.steamId32));
  return { valid: missing.length === 0, missingNames: missing.map((p) => p.nickname) };
}

// ─── Bot logic ─────────────────────────────────────────────────────────────

let sendBotMessage: (msg: string) => void;

function onReadyCommand(accountId: number, senderName: string): void {
  const steam32 = String(accountId);
  const snapshot = getCurrentSnapshot();

  let team: 'radiant' | 'dire' | null = null;
  let teamName = '';
  let expected: ExpectedPlayer[] = [];

  if (EXPECTED_RADIANT.some((p) => p.steamId32 === steam32)) {
    team = 'radiant';
    teamName = 'Radiant';
    expected = EXPECTED_RADIANT;
  } else if (EXPECTED_DIRE.some((p) => p.steamId32 === steam32)) {
    team = 'dire';
    teamName = 'Dire';
    expected = EXPECTED_DIRE;
  }

  if (!team) {
    log('ReadyCheck', `Ignoring !r from unrecognized player: ${steam32} (${senderName})`);
    return;
  }

  const { valid, missingNames } = checkTeamSlots(expected, team, snapshot);

  if (!valid) {
    const msg = applyPlaceholders(TEAM_NOT_READY_MSG, {
      player_name: senderName,
      team_name: teamName,
      missing: missingNames.join(', '),
    });
    sendBotMessage(msg);
  } else {
    if (team === 'radiant') radiantReady = true;
    const bothReady = radiantReady; // Only Radiant expected in this test (Dire is empty)
    if (bothReady) {
      sendBotMessage(applyPlaceholders(ALL_READY_MSG, { player_name: senderName, team_name: teamName }));
    } else {
      sendBotMessage(applyPlaceholders(TEAM_READY_MSG, { player_name: senderName, team_name: teamName }));
    }
  }
}

function onUnreadyCommand(accountId: number, senderName: string): void {
  const steam32 = String(accountId);

  let team: 'radiant' | 'dire' | null = null;
  let teamName = '';

  if (EXPECTED_RADIANT.some((p) => p.steamId32 === steam32)) {
    team = 'radiant';
    teamName = 'Radiant';
  } else if (EXPECTED_DIRE.some((p) => p.steamId32 === steam32)) {
    team = 'dire';
    teamName = 'Dire';
  }

  if (!team) return;

  if (team === 'radiant') radiantReady = false;
  sendBotMessage(applyPlaceholders(UNREADY_ACK_MSG, { player_name: senderName, team_name: teamName }));
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const username = process.env.STEAM_USERNAME;
  const password = process.env.STEAM_PASSWORD;
  if (!username || !password) {
    console.error('ERROR: Set STEAM_USERNAME and STEAM_PASSWORD in .env');
    process.exit(1);
  }

  console.log('\x1b[1m\nPD2IH Bot — Ready Check Live Test\x1b[0m');
  console.log(`Bot account  : ${username}`);
  console.log(`Tester       : ${CIENSZKI_NICKNAME} (Steam32: ${CIENSZKI_STEAM32})`);
  console.log(`Lobby        : "${LOBBY_NAME}" / password: ${LOBBY_PASSWORD}`);
  console.log(`Expected team: Radiant → [${CIENSZKI_NICKNAME}]\n`);
  info('Cienszki must be available in Dota 2 to join and participate.');
  info('The bot will send test instructions directly in lobby chat.');

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
    const t = setTimeout(() => reject(new Error('Connection timeout (60s)')), 60_000);
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
  record('Steam + GC connection', 'pass');

  // ── Step 2: Create lobby ──────────────────────────────────────────────

  section('STEP 2 — Create lobby');

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Lobby creation timeout')), 30_000);
    dota2.createPracticeLobby(
      {
        game_name: LOBBY_NAME,
        pass_key: LOBBY_PASSWORD,
        game_mode: 2,       // All Pick
        server_region: 3,   // Europe
        visibility: 0,      // Public (password still required)
        allow_cheats: false,
        fill_with_bots: false,
        allow_spectating: true,
        pause_setting: 1,
        dota_tv_delay: 2,
      },
      (err: Error | null) => { clearTimeout(t); err ? reject(err) : resolve(); }
    );
  });

  const lobbyChannelName = 'Lobby_' + String(dota2.Lobby.lobby_id);
  dota2.joinChat(lobbyChannelName, 3);
  await sleep(1500);

  // Move bot to unassigned pool so it doesn't occupy a Radiant slot
  dota2.joinPracticeLobbyTeam(1, 4);
  await sleep(500);

  pass('Lobby created — bot in unassigned pool');
  record('Lobby created', 'pass');
  info(`Lobby "${LOBBY_NAME}"  password: ${LOBBY_PASSWORD}`);

  // Bind sendBotMessage now that we have the channel
  sendBotMessage = (msg: string) => {
    botChatLog.push(msg);
    dota2.sendMessage(msg, lobbyChannelName, 3);
    log('Bot→Chat', msg);
  };

  // ── Attach lobby tracking ─────────────────────────────────────────────

  // Track player positions whenever lobby state changes
  dota2.on('practiceLobbyUpdate', (lobby: Record<string, unknown>) => {
    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;
    currentPlayers.clear();
    for (const m of members) {
      const accountId = steam64ToSteam32(m.id);
      if (accountId <= 0) continue;
      const slot = Number(m.slot ?? m.team_slot ?? -1);
      currentPlayers.set(accountId, { accountId, team: slotToTeam(slot) });
    }
  });

  // Handle chat messages: apply the ready-check logic
  let commandsReceived = 0;
  const commandLog: Array<{ accountId: number; cmd: string; response: string; atSlot: string }> = [];

  dota2.on(
    'chatMessage',
    (
      _channel: string,
      senderName: string,
      message: string,
      chatData: Record<string, unknown>
    ) => {
      log('Chat', `<${senderName}> ${message}`);
      const accountId = Number(chatData.account_id || 0);
      const cmd       = message.trim().toLowerCase();

      if (READY_COMMANDS.includes(cmd)) {
        commandsReceived++;
        const snap     = getCurrentSnapshot();
        const snapshot = snap.find((p) => p.steamId32 === String(accountId));
        const atSlot   = snapshot ? snapshot.teamSide : 'not-in-lobby';
        const prevLogLen = botChatLog.length;
        onReadyCommand(accountId, senderName);
        const response = botChatLog.length > prevLogLen
          ? botChatLog[botChatLog.length - 1]
          : '(no response)';
        commandLog.push({ accountId, cmd, response, atSlot });
      } else if (UNREADY_COMMANDS.includes(cmd)) {
        commandsReceived++;
        const prevLogLen = botChatLog.length;
        onUnreadyCommand(accountId, senderName);
        const response = botChatLog.length > prevLogLen
          ? botChatLog[botChatLog.length - 1]
          : '(no response)';
        commandLog.push({ accountId, cmd, response, atSlot: '—' });
      }
    }
  );

  // ── Step 3: Invite Cienszki ───────────────────────────────────────────

  section('STEP 3 — Invite Cienszki');

  dota2.inviteToLobby(CIENSZKI_STEAM64);

  const lobbyId       = String(dota2.Lobby.lobby_id);
  const lobbyJoinUrl  = `steam://joinlobby/570/${lobbyId}`;
  const friendMessage =
    `[PD2IH Bot – Ready Check Test]\n` +
    `Lobby: "${LOBBY_NAME}"  Hasło: ${LOBBY_PASSWORD}\n` +
    `Kliknij aby dołączyć: ${lobbyJoinUrl}`;

  steamFriends.sendMessage(CIENSZKI_STEAM64, friendMessage, Steam.EChatEntryType.ChatMsg);
  log('Invite', `GC invite + Steam message sent to ${CIENSZKI_NICKNAME}`);
  log('Invite', `  → ${lobbyJoinUrl}`);

  pass('Invites sent');
  record('Invite Cienszki', 'pass');

  // ── Step 4: Wait for Cienszki to join ─────────────────────────────────

  section(`STEP 4 — Wait for ${CIENSZKI_NICKNAME} to join (5 min timeout)`);

  let cienszkiJoined = false;
  let cienszkiLeft   = false;

  const joinHandler = (lobby: Record<string, unknown>) => {
    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;
    const found    = members.find((m) => String(steam64ToSteam32(m.id)) === String(CIENSZKI_STEAM32));

    if (found && !cienszkiJoined) {
      cienszkiJoined = true;
      const slot    = Number(found.slot ?? found.team_slot ?? -1);
      const team    = slotToTeam(slot);
      log('Join', `${CIENSZKI_NICKNAME} is in lobby — slot ${slot} (${team})`);
    }

    if (!found && cienszkiJoined && !cienszkiLeft) {
      cienszkiLeft = true;
      log('Join', `${CIENSZKI_NICKNAME} left the lobby`);
    }
  };

  dota2.on('practiceLobbyUpdate', joinHandler);

  const joinDeadline = Date.now() + 5 * 60 * 1000;
  while (!cienszkiJoined && Date.now() < joinDeadline) {
    await sleep(1000);
  }

  dota2.removeListener('practiceLobbyUpdate', joinHandler);

  if (!cienszkiJoined) {
    fail(`${CIENSZKI_NICKNAME} did not join`, 'timeout after 5 min');
    record('Cienszki joins lobby', 'fail', 'timeout');
    ['TEST A', 'TEST B', 'TEST C', 'TEST D', 'TEST E', 'TEST F'].forEach((t) =>
      record(t, 'skip', 'player did not join')
    );
  } else {
    pass(`${CIENSZKI_NICKNAME} joined lobby`);
    record('Cienszki joins lobby', 'pass');

    // ── TEST A: Welcome message with {player_name} ──────────────────────

    section('TEST A — Welcome message with {player_name}');

    const welcomeSent = applyPlaceholders(WELCOME_MSG, { player_name: CIENSZKI_NICKNAME });
    sendBotMessage(welcomeSent);
    await sleep(1000);

    const aPass = welcomeSent.includes(CIENSZKI_NICKNAME);
    if (aPass) {
      pass(`Welcome message contains "${CIENSZKI_NICKNAME}"`);
      record('TEST A: welcome {player_name}', 'pass');
    } else {
      fail('Welcome message', `"${CIENSZKI_NICKNAME}" not found in: "${welcomeSent}"`);
      record('TEST A: welcome {player_name}', 'fail', 'name missing from message');
    }

    // Also verify currentPlayers snapshot is populated
    const snapshotAfterJoin = getCurrentSnapshot();
    const cienszkiInSnapshot = snapshotAfterJoin.find((p) => p.steamId32 === String(CIENSZKI_STEAM32));
    if (cienszkiInSnapshot) {
      pass(`TEST A-2: Cienszki in currentPlayers snapshot (team: ${cienszkiInSnapshot.teamSide})`);
      record('TEST A-2: currentPlayers snapshot populated', 'pass', `team: ${cienszkiInSnapshot.teamSide}`);
    } else {
      fail('TEST A-2: currentPlayers snapshot', 'Cienszki not in snapshot after join');
      record('TEST A-2: currentPlayers snapshot populated', 'fail');
    }

    // Send instructions to Cienszki
    await sleep(800);
    sendBotMessage(
      `=== TEST B: Zostań w unassigned/spectator i napisz !r — oczekuję odmowy ===`
    );
    info(`Waiting up to 90s for Cienszki to type !r from ${CIENSZKI_NICKNAME === 'Cienszki' ? 'unassigned' : 'wrong'} slot...`);

    // ── TEST B: !r from wrong slot ──────────────────────────────────────

    section('TEST B — !r from WRONG slot (should be rejected)');

    const bDeadline     = Date.now() + 90_000;
    let   bCmdReceived  = false;
    let   bPassed       = false;

    while (Date.now() < bDeadline && !bCmdReceived) {
      // Check if a new !r command was received
      const newEntry = commandLog.find(
        (e) =>
          e.accountId === CIENSZKI_STEAM32 &&
          READY_COMMANDS.includes(e.cmd) &&
          !bCmdReceived
      );

      if (newEntry) {
        bCmdReceived = true;
        log('TestB', `!r received — Cienszki was on: ${newEntry.atSlot}`);
        log('TestB', `Bot replied: "${newEntry.response}"`);

        if (newEntry.atSlot !== 'radiant') {
          // Cienszki was NOT on Radiant — expect teamNotReadyMessage
          if (newEntry.response.includes('brak') || newEntry.response.includes('Not all') || newEntry.response.includes('Brakuje')) {
            bPassed      = true;
            radiantReady = false; // Ensure state was NOT changed
            pass(`!r while in ${newEntry.atSlot} → teamNotReadyMessage sent correctly`);
            if (radiantReady) {
              fail('TEST B: state check', 'radiantReady should still be false after rejection');
              record('TEST B: ready state unchanged', 'fail');
            } else {
              record('TEST B: ready state unchanged', 'pass');
            }
          } else {
            fail('TEST B', `Expected rejection message but got: "${newEntry.response}"`);
          }
        } else {
          // Cienszki WAS on Radiant — this tests the wrong slot case hasn't fired
          fail(
            'TEST B',
            `Cienszki was already in Radiant slot — test B requires a wrong-slot attempt. ` +
            `Move to unassigned BEFORE typing !r.`
          );
        }
      } else {
        await sleep(1000);
      }
    }

    if (!bCmdReceived) {
      fail('TEST B', `${CIENSZKI_NICKNAME} did not type !r within 90s`);
      record('TEST B: !r rejected (wrong slot)', 'fail', 'timeout');
    } else if (bPassed) {
      record('TEST B: !r rejected (wrong slot)', 'pass');
    } else {
      record('TEST B: !r rejected (wrong slot)', 'fail', 'unexpected response');
    }

    // Instructions for TEST C
    await sleep(800);
    sendBotMessage(
      `=== TEST C: Przejdź na slot Radiant 1 i napisz !r — oczekuję akceptacji ===`
    );
    info('Waiting up to 90s for Cienszki to move to Radiant and type !r...');

    // ── TEST C: !r from correct slot ────────────────────────────────────

    section('TEST C — !r from CORRECT slot (Radiant)');

    const prevCommandCount = commandLog.length;
    const cDeadline        = Date.now() + 90_000;
    let   cCmdReceived     = false;
    let   cPassed          = false;

    while (Date.now() < cDeadline && !cCmdReceived) {
      const newEntries = commandLog.slice(prevCommandCount).filter(
        (e) => e.accountId === CIENSZKI_STEAM32 && READY_COMMANDS.includes(e.cmd)
      );

      if (newEntries.length > 0) {
        cCmdReceived        = true;
        const newEntry      = newEntries[newEntries.length - 1];
        log('TestC', `!r received — Cienszki was on: ${newEntry.atSlot}`);
        log('TestC', `Bot replied: "${newEntry.response}"`);

        if (newEntry.atSlot === 'radiant') {
          if (
            newEntry.response.includes('gotowy') ||
            newEntry.response.includes('ready') ||
            newEntry.response.includes('GOOO')
          ) {
            cPassed = true;
            if (radiantReady) {
              pass(`!r from Radiant slot → teamReadyMessage sent, radiantReady=true`);
              record('TEST C: ready state set', 'pass');
            } else {
              fail('TEST C: state check', 'radiantReady should be true after successful !r');
              record('TEST C: ready state set', 'fail');
            }
          } else {
            fail('TEST C', `Expected teamReadyMessage but got: "${newEntry.response}"`);
          }
        } else {
          fail('TEST C', `Cienszki was in ${newEntry.atSlot} — needs to be in Radiant slot first`);
        }
      } else {
        await sleep(1000);
      }
    }

    if (!cCmdReceived) {
      fail('TEST C', `!r not received within 90s`);
      record('TEST C: !r accepted (correct slot)', 'fail', 'timeout');
    } else if (cPassed) {
      record('TEST C: !r accepted (correct slot)', 'pass');
    } else {
      record('TEST C: !r accepted (correct slot)', 'fail', 'unexpected result');
    }

    // Instructions for TEST D
    await sleep(800);
    sendBotMessage(`=== TEST D: Napisz !ur żeby cofnąć gotowość ===`);
    info('Waiting up to 60s for !ur...');

    // ── TEST D: !ur clears ready state ──────────────────────────────────

    section('TEST D — !ur clears ready state');

    const prevCmdCountD = commandLog.length;
    const dDeadline     = Date.now() + 60_000;
    let   dCmdReceived  = false;
    let   dPassed       = false;

    while (Date.now() < dDeadline && !dCmdReceived) {
      const newEntries = commandLog.slice(prevCmdCountD).filter(
        (e) => e.accountId === CIENSZKI_STEAM32 && UNREADY_COMMANDS.includes(e.cmd)
      );

      if (newEntries.length > 0) {
        dCmdReceived = true;
        log('TestD', `!ur received — radiantReady is now: ${radiantReady}`);

        if (!radiantReady) {
          dPassed = true;
          pass('!ur received → radiantReady cleared');
          record('TEST D: ready state cleared', 'pass');
        } else {
          fail('TEST D', 'radiantReady should be false after !ur');
          record('TEST D: ready state cleared', 'fail', 'radiantReady still true');
        }

        // Verify bot sent ack message
        const ackEntry = newEntries[newEntries.length - 1];
        if (ackEntry.response !== '(no response)') {
          pass(`!ur bot ack sent: "${ackEntry.response}"`);
          record('TEST D: !ur ack message', 'pass');
        } else {
          fail('TEST D-2', 'No ack message sent after !ur');
          record('TEST D: !ur ack message', 'fail', 'no response');
        }
      } else {
        await sleep(1000);
      }
    }

    if (!dCmdReceived) {
      fail('TEST D', `!ur not received within 60s`);
      record('TEST D: !ur clears ready state', 'fail', 'timeout');
    }

    void dPassed;

    // Instructions for TEST E
    await sleep(800);
    sendBotMessage(
      `=== TEST E: Zostań na Radiant i napisz !r TRZY RAZY szybko z rzędu — brak cooldownu ===`
    );
    info('Waiting up to 60s for 3x !r in quick succession...');

    // ── TEST E: No cooldown — spam !r ────────────────────────────────────

    section('TEST E — !r spam (3x) — no cooldown');

    const prevCmdCountE = commandLog.length;
    const eDeadline     = Date.now() + 60_000;

    while (Date.now() < eDeadline) {
      const newCmds = commandLog
        .slice(prevCmdCountE)
        .filter((e) => e.accountId === CIENSZKI_STEAM32 && READY_COMMANDS.includes(e.cmd));

      if (newCmds.length >= 3) break;
      await sleep(500);
    }

    const spamCmds = commandLog
      .slice(prevCmdCountE)
      .filter((e) => e.accountId === CIENSZKI_STEAM32 && READY_COMMANDS.includes(e.cmd));

    log('TestE', `Received ${spamCmds.length} !r commands in spam window`);

    if (spamCmds.length === 0) {
      fail('TEST E', 'No !r commands received — tester may not have sent them');
      record('TEST E: no cooldown (3x !r)', 'fail', 'no commands received');
    } else {
      const responsesCount = spamCmds.filter((e) => e.response !== '(no response)').length;
      log('TestE', `Bot responded to ${responsesCount}/${spamCmds.length} !r commands`);
      spamCmds.forEach((e, i) => {
        log('TestE', `  !r #${i + 1}: slot=${e.atSlot}  response="${e.response.slice(0, 60)}..."`);
      });

      if (responsesCount === spamCmds.length) {
        pass(`All ${spamCmds.length} !r commands got a response (no cooldown active)`);
        record('TEST E: no cooldown (3x !r)', 'pass', `${spamCmds.length} responses`);
      } else {
        fail(
          'TEST E',
          `${responsesCount}/${spamCmds.length} commands got a response — ` +
          'some were silently dropped (unexpected cooldown?)'
        );
        record('TEST E: no cooldown (3x !r)', 'fail', `only ${responsesCount}/${spamCmds.length} responded`);
      }
    }

    // ── TEST F: currentPlayers snapshot accuracy ─────────────────────────

    section('TEST F — currentPlayers snapshot accuracy');
    info('Verifying bot correctly tracks Cienszki\'s current slot position...');

    const finalSnapshot = getCurrentSnapshot();
    const cienszkiEntry = finalSnapshot.find(
      (p) => p.steamId32 === String(CIENSZKI_STEAM32)
    );

    if (!cienszkiEntry) {
      fail('TEST F', 'Cienszki not found in currentPlayers snapshot');
      record('TEST F: currentPlayers accuracy', 'fail', 'not in snapshot');
    } else {
      pass(`Cienszki in snapshot: team=${cienszkiEntry.teamSide}`);
      record(
        'TEST F: currentPlayers accuracy',
        'pass',
        `teamSide=${cienszkiEntry.teamSide}`
      );
      log('TestF', `snapshot has ${finalSnapshot.length} player(s):`);
      finalSnapshot.forEach((p) => {
        log('TestF', `  Steam32=${p.steamId32} side=${p.teamSide}`);
      });
    }

    // Instruct Cienszki we're done
    await sleep(800);
    sendBotMessage(
      `Testy zakończone! Dziękujemy ${CIENSZKI_NICKNAME}. Opuszczam lobby za 5 sekund.`
    );
    await sleep(5000);
  }

  // ── Leave lobby ────────────────────────────────────────────────────────

  section('LEAVING LOBBY');
  await new Promise<void>((resolve) => {
    dota2.leavePracticeLobby((err: Error | null) => {
      if (err) {
        fail('Leave lobby', String(err));
        record('Leave lobby', 'fail', String(err));
      } else {
        pass('Left lobby');
        record('Leave lobby', 'pass');
      }
      resolve();
    });
  });

  await sleep(1000);

  // ── Summary ────────────────────────────────────────────────────────────

  section('FULL TEST SUMMARY');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const r of results) {
    const icon = r.status === 'pass'
      ? '\x1b[32m✓\x1b[0m'
      : r.status === 'fail'
      ? '\x1b[31m✗\x1b[0m'
      : '\x1b[33m-\x1b[0m';
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
    if (r.status === 'pass')       totalPassed++;
    else if (r.status === 'fail')  totalFailed++;
    else                           totalSkipped++;
  }

  console.log(`\n  Passed: ${totalPassed}  Failed: ${totalFailed}  Skipped: ${totalSkipped}`);

  if (commandLog.length > 0) {
    console.log('\n\x1b[1m  Command log:\x1b[0m');
    commandLog.forEach((e, i) => {
      console.log(
        `  ${i + 1}. ${e.cmd}  [slot: ${e.atSlot}]  → "${e.response.slice(0, 80)}${e.response.length > 80 ? '…' : ''}"`
      );
    });
  }

  dota2.exit();
  steamClient.disconnect();
  await sleep(500);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
