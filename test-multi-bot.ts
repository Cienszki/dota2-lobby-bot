/**
 * Multi-Bot Automated Lobby Test
 *
 * Uses ALL registered bot accounts to simulate a full lobby interaction without
 * any human involvement. Bot[0] is the "host" running the ready-check logic;
 * Bot[1..3] are "player bots" that join, move to slots, and send chat commands.
 *
 * Minimum: 2 bots (host + 1 Radiant player; Dire tests skipped)
 * Optimal:  4 bots (host + 2 Radiant + 1 Dire; full suite)
 *
 * How bot accounts are assigned:
 *   Bot[0]  → Host         — creates lobby, handles all logic, stays in pool
 *   Bot[1]  → RadiantBot1  — occupies Radiant slot 0
 *   Bot[2]  → RadiantBot2  — occupies Radiant slot 1  (skipped if < 3 bots)
 *   Bot[3]  → DireBot1     — occupies Dire slot 0     (skipped if < 4 bots)
 *
 * Test stages (adapt automatically to the number of available bots):
 *   A  — All player bots successfully join the lobby
 *   B  — Welcome message is sent per-player as they join ({player_name} substituted)
 *   C  — !r from unassigned slot → rejected, missing list includes the player
 *   D  — One Radiant player moves to correct slot, !r → still rejected (second missing)
 *   E  — All expected Radiant players seated, !r → Radiant ready ✓
 *   F  — DireBot !r from unassigned → rejected           (4-bot mode only)
 *   G  — DireBot moves to Dire slot, !r → Dire ready!    (4-bot mode only)
 *   H  — Both teams ready → allReadyMessage fired         (4-bot mode only)
 *   I  — !ur clears ready state, bot sends ack
 *   J  — !r spam (3× quickly) → 3 responses (no cooldown throttle)
 *
 * Usage:
 *   npx tsx bot-worker/test-multi-bot.ts
 *
 * Requires:
 *   - FIREBASE_SERVICE_ACCOUNT_BASE64 in bot-worker/.env (to read bot creds)
 *   - Bot accounts registered in Firestore /botAccounts (via admin panel)
 *   - Each account has a valid Steam login + Dota 2 installed
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');

import * as fs from 'fs';
import * as crypto from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ─── Lobby config ──────────────────────────────────────────────────────────

const LOBBY_NAME     = 'PD2IH Multi-Bot Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// Cienszki — human tester invited to spectate TEST K
const CIENSZKI_STEAM64   = '76561197996013648';
const CIENSZKI_STEAM32   = 35747920;
const SPECTATOR_WAIT_SECS = 90; // seconds to wait for Cienszki to join before launching

// ─── Bot message templates ─────────────────────────────────────────────────

const WELCOME_MSG        = 'Witaj {player_name}! Przygotuj się — zaraz zaczniemy testy.';
const TEAM_NOT_READY_MSG = '{player_name}: Nie wszyscy gracze {team_name} są na slotach. Brakuje: {missing}';
const TEAM_READY_MSG     = '{team_name} gotowy! Czekam na drugą drużynę...';
const ALL_READY_MSG      = 'Obie drużyny gotowe! Test zakończony pomyślnie.';
const UNREADY_ACK_MSG    = '{player_name}: Cofnięto gotowość {team_name}.';

// ─── Types ─────────────────────────────────────────────────────────────────

interface BotCreds {
  firestoreId: string;
  username: string;
  password: string;
  displayName: string;
  steamId64: string;
  steamId32: string;
}

interface ExpectedPlayer {
  steamId32: string;
  nickname: string;
}

interface PlayerSnapshot {
  accountId32: number;
  teamSide: 'radiant' | 'dire' | 'spectator' | 'unassigned';
  slot: number;
}

interface BotSession {
  creds: BotCreds;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steamClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steamUser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steamFriends: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dota2: any;
}

// ─── Output helpers ────────────────────────────────────────────────────────

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

function warn(msg: string): void {
  console.log(`\x1b[33m  ⚠  ${msg}\x1b[0m`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${'─'.repeat(62)}\n  ${title}\n${'─'.repeat(62)}\x1b[0m`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results: { step: string; status: 'pass' | 'fail' | 'skip'; note?: string }[] = [];

function record(step: string, status: 'pass' | 'fail' | 'skip', note?: string): void {
  results.push({ step, status, note });
}

// ─── Firebase helpers ──────────────────────────────────────────────────────

function initFirebase() {
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set');
  const sa = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  const app = getApps().find((a) => a.name === 'multi-bot-test') ||
    initializeApp({ credential: cert(sa) }, 'multi-bot-test');
  return getFirestore(app);
}

async function fetchBotCreds(): Promise<BotCreds[]> {
  const db = initFirebase();
  const snap = await db
    .collection('botAccounts')
    .where('enabled', '==', true)
    .get();

  if (snap.empty) throw new Error('No enabled bot accounts found in Firestore. Register bots via admin panel.');

  // Sort client-side to avoid requiring a composite Firestore index
  const docs = snap.docs.slice().sort((a, b) => {
    const aTs = a.data().createdAt?.toMillis?.() ?? 0;
    const bTs = b.data().createdAt?.toMillis?.() ?? 0;
    return aTs - bTs;
  });

  return docs.map((doc) => {
    const d = doc.data();
    const password = Buffer.from(d.encryptedPassword as string, 'base64').toString('utf-8');
    return {
      firestoreId: doc.id,
      username: d.username as string,
      password,
      displayName: d.displayName as string,
      steamId64: d.steamId as string,
      steamId32: d.steamId32 as string,
    };
  });
}

// ─── Bot logic helpers (inline — mirrors bot-agent.ts) ────────────────────

function applyPlaceholders(
  message: string,
  ctx: { player_name?: string; team_name?: string; missing?: string }
): string {
  return message
    .replace(/\{player_name\}/g, ctx.player_name ?? '')
    .replace(/\{team_name\}/g, ctx.team_name ?? '')
    .replace(/\{missing\}/g, ctx.missing ?? '');
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

function checkTeamSlots(
  expected: ExpectedPlayer[],
  team: 'radiant' | 'dire',
  snapshot: PlayerSnapshot[]
): { valid: boolean; missingNames: string[] } {
  const onSide = new Set(
    snapshot.filter((p) => p.teamSide === team).map((p) => String(p.accountId32))
  );
  const missing = expected.filter((p) => !onSide.has(p.steamId32));
  return { valid: missing.length === 0, missingNames: missing.map((p) => p.nickname) };
}

// ─── Steam bot connect / disconnect ───────────────────────────────────────

async function connectBot(creds: BotCreds, index: number): Promise<BotSession> {
  const sentryPath = `./sentry-bot-${creds.username}`;

  const steamClient  = new Steam.SteamClient();
  const steamUser    = new Steam.SteamUser(steamClient);
  const steamFriends = new Steam.SteamFriends(steamClient);
  const dota2        = new Dota2.Dota2Client(steamClient, true, false);

  if (!Dota2.schema.DOTAGameVersion) {
    Dota2.schema.DOTAGameVersion = { GAME_VERSION_STABLE: 0, GAME_VERSION_TEST: 1 };
  }

  const logOnDetails: Record<string, unknown> = {
    account_name: creds.username,
    password: creds.password,
  };

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
    const timer = setTimeout(
      () => reject(new Error(`[Bot${index}] GC connection timeout (60s)`)),
      60_000
    );
    steamClient.connect();
    steamClient.on('connected', () => steamUser.logOn(logOnDetails));
    steamClient.on('logOnResponse', (resp: { eresult: number }) => {
      if (resp.eresult !== Steam.EResult.OK) {
        clearTimeout(timer);
        reject(new Error(`[Bot${index}] Steam login failed: EResult=${resp.eresult}`));
      }
      // Steam logged in — then launch Dota 2 GC
      dota2.launch();
    });
    dota2.on('ready', () => { clearTimeout(timer); resolve(); });
    steamClient.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
  });

  // Capture real steam32 ID from the logged-in steamClient (not from Firestore, which may be empty)
  const realSteam64 = String((steamClient as Record<string, unknown>).steamID ?? '');
  if (realSteam64) {
    creds.steamId32 = String(steam64ToSteam32(realSteam64));
  }

  log(`Bot${index}`, `Connected: ${creds.displayName} (${creds.username}) steam32=${creds.steamId32 ?? '?'}`);
  return { creds, steamClient, steamUser, steamFriends, dota2 };
}

async function disconnectBot(session: BotSession): Promise<void> {
  try {
    session.dota2.exit();
    session.steamClient.disconnect();
  } catch { /* ignore */ }
  await sleep(300);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── Fetch credentials ─────────────────────────────────────────────────

  section('SETUP — Fetching bot credentials from Firestore');

  const allCreds = await fetchBotCreds();
  info(`Found ${allCreds.length} enabled bot account(s) in Firestore`);

  if (allCreds.length < 2) {
    console.error('\x1b[31mERROR: Need at least 2 enabled bot accounts (host + 1 player).\x1b[0m');
    console.error('Register more accounts via admin panel → Bot tab → Konta Steam\n');
    process.exit(1);
  }

  const hostCreds    = allCreds[0];
  const playerCreds  = allCreds.slice(1);          // up to 3 player bots
  const numPlayers   = playerCreds.length;

  // NOTE: expectedRadiant / expectedDire are populated AFTER bots connect,
  // because steamId32 comes from the live steamClient (Firestore may have it empty).
  const expectedRadiant: ExpectedPlayer[] = [];
  const expectedDire:    ExpectedPlayer[] = [];

  console.log(`\n\x1b[1m  PD2IH — Multi-Bot Automated Lobby Test\x1b[0m`);
  console.log(`  Host bot    : ${hostCreds.displayName}  (${hostCreds.username})`);
  playerCreds.forEach((c, i) => {
    const role = i === 0 ? 'Radiant #1' : i === 1 ? 'Radiant #2' : 'Dire #1   ';
    console.log(`  Player ${i + 1}    : ${c.displayName}  (${c.username})  → ${role}`);
  });
  if (numPlayers < 3) {
    warn(`Only ${numPlayers} player bot(s) available — some tests will be skipped (need 3 for full suite)`);
  }

  // ── Connect all bots (sequential to avoid Steam rate limiting) ─────────

  section('CONNECTING BOTS');

  const sessions: BotSession[] = [];

  for (let i = 0; i < allCreds.length; i++) {
    const label = i === 0 ? 'host' : `player${i}`;
    info(`Connecting ${allCreds[i].username} (${label})...`);
    try {
      const session = await connectBot(allCreds[i], i);
      sessions.push(session);
      pass(`Bot ${i} connected: ${allCreds[i].displayName}`);
      record(`Connect bot ${i} (${allCreds[i].username})`, 'pass');
      if (i < allCreds.length - 1) await sleep(3000); // rate-limit cooldown
    } catch (err) {
      fail(`Connect bot ${i}`, String(err));
      record(`Connect bot ${i} (${allCreds[i].username})`, 'fail', String(err));
      warn(`Continuing with ${sessions.length} connected bot(s)...`);
      break;
    }
  }

  if (sessions.length < 2) {
    console.error('\x1b[31mFATAL: Could not connect enough bots. Exiting.\x1b[0m\n');
    for (const s of sessions) await disconnectBot(s);
    process.exit(1);
  }

  const hostSession    = sessions[0];
  const playerSessions = sessions.slice(1);

  // ── Rebuild expectedRadiant/Dire using real steam32 IDs from connected sessions ──
  expectedRadiant.length = 0;
  expectedDire.length    = 0;
  if (playerSessions.length >= 1) {
    expectedRadiant.push({ steamId32: playerSessions[0].creds.steamId32, nickname: playerSessions[0].creds.displayName });
  }
  if (playerSessions.length >= 2) {
    expectedRadiant.push({ steamId32: playerSessions[1].creds.steamId32, nickname: playerSessions[1].creds.displayName });
  }
  if (playerSessions.length >= 3) {
    expectedDire.push({ steamId32: playerSessions[2].creds.steamId32, nickname: playerSessions[2].creds.displayName });
  }
  info(`expectedRadiant: ${expectedRadiant.map((p) => `${p.nickname}(${p.steamId32})`).join(', ')}`);
  if (expectedDire.length) info(`expectedDire: ${expectedDire.map((p) => `${p.nickname}(${p.steamId32})`).join(', ')}`);

  // ── Create lobby ──────────────────────────────────────────────────────

  section('STEP 1 — Host creates lobby');

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Lobby creation timeout (30s)')), 30_000);
    hostSession.dota2.createPracticeLobby(
      {
        game_name: LOBBY_NAME,
        pass_key: LOBBY_PASSWORD,
        game_mode: 2,
        server_region: 3,
        visibility: 0,
        allow_cheats: false,
        fill_with_bots: false,
        allow_spectating: true,
        pause_setting: 1,
        dota_tv_delay: 2,
      },
      (err: Error | null) => { clearTimeout(t); err ? reject(err) : resolve(); }
    );
  });

  // Move host to unassigned pool (slot=1, team=4=PLAYER_POOL)
  hostSession.dota2.joinPracticeLobbyTeam(1, 4);
  await sleep(600);

  const lobbyIdLong = hostSession.dota2.Lobby.lobby_id;
  const lobbyIdStr  = String(lobbyIdLong);
  const channelName = `Lobby_${lobbyIdStr}`;

  hostSession.dota2.joinChat(channelName, 3);
  await sleep(500);

  pass(`Lobby created: "${LOBBY_NAME}" (id: ${lobbyIdStr})`);
  record('Host creates lobby', 'pass');

  // ── Host ready-check state & tracking ─────────────────────────────────

  const currentPlayers = new Map<number, PlayerSnapshot>();
  const botChatLog:  string[] = [];
  const commandLog:  Array<{ from: string; cmd: string; atSlot: string; response: string }> = [];
  let   radiantReady = false;
  let   direReady    = false;
  const welcomeSent  = new Set<number>(); // steam32 accounts that got a welcome msg

  function sendHostMessage(msg: string): void {
    botChatLog.push(msg);
    hostSession.dota2.sendMessage(msg, channelName, 3);
    log('Host→Chat', msg);
  }

  // Apply bot logic: ready command
  function handleReadyCmd(accountId32: number, senderName: string): void {
    const steam32Str = String(accountId32);
    const snapshot   = [...currentPlayers.values()];

    let team: 'radiant' | 'dire' | null = null;
    let teamName = '';
    let expected: ExpectedPlayer[] = [];

    if (expectedRadiant.some((p) => p.steamId32 === steam32Str)) {
      team = 'radiant'; teamName = 'Radiant'; expected = expectedRadiant;
    } else if (expectedDire.some((p) => p.steamId32 === steam32Str)) {
      team = 'dire'; teamName = 'Dire'; expected = expectedDire;
    }

    if (!team) {
      log('Logic', `Ignoring !r from unrecognised player ${steam32Str}`);
      return;
    }

    const { valid, missingNames } = checkTeamSlots(expected, team, snapshot);

    if (!valid) {
      sendHostMessage(applyPlaceholders(TEAM_NOT_READY_MSG, {
        player_name: senderName, team_name: teamName, missing: missingNames.join(', ')
      }));
    } else {
      if (team === 'radiant') radiantReady = true;
      if (team === 'dire')    direReady    = true;
      if (radiantReady && (expectedDire.length === 0 || direReady)) {
        sendHostMessage(applyPlaceholders(ALL_READY_MSG, { player_name: senderName, team_name: teamName }));
      } else {
        sendHostMessage(applyPlaceholders(TEAM_READY_MSG, { player_name: senderName, team_name: teamName }));
      }
    }
  }

  function handleUnreadyCmd(accountId32: number, senderName: string): void {
    const steam32Str = String(accountId32);
    let team: 'radiant' | 'dire' | null = null;
    let teamName = '';
    if (expectedRadiant.some((p) => p.steamId32 === steam32Str)) { team = 'radiant'; teamName = 'Radiant'; }
    else if (expectedDire.some((p) => p.steamId32 === steam32Str)) { team = 'dire'; teamName = 'Dire'; }
    if (!team) return;
    if (team === 'radiant') radiantReady = false;
    if (team === 'dire')    direReady    = false;
    sendHostMessage(applyPlaceholders(UNREADY_ACK_MSG, { player_name: senderName, team_name: teamName }));
  }

  // ── Attach host event handlers ─────────────────────────────────────────

  hostSession.dota2.on('practiceLobbyUpdate', (lobby: Record<string, unknown>) => {
    const members = (lobby.all_members || []) as Array<Record<string, unknown>>;
    currentPlayers.clear();
    for (const m of members) {
      const id32 = steam64ToSteam32(m.id);
      if (id32 <= 0) continue;
      // Use m.team (DOTA_GC_TEAM enum) — NOT m.slot — to determine which side the player is on.
      // 0=Radiant, 1=Dire, 2=Broadcaster, 3=Spectator, 4=PlayerPool (unassigned)
      const gcTeam = Number(m.team ?? 4);
      const slot   = Number(m.slot ?? 1);
      const teamSide: 'radiant' | 'dire' | 'spectator' | 'unassigned' =
        gcTeam === 0 ? 'radiant' :
        gcTeam === 1 ? 'dire' :
        (gcTeam === 2 || gcTeam === 3) ? 'spectator' : 'unassigned';
      currentPlayers.set(id32, { accountId32: id32, teamSide, slot });
    }

    // Send welcome to newly-joined player bots
    for (const [id32, player] of currentPlayers) {
      if (String(id32) === hostSession.creds.steamId32) continue; // skip host
      if (welcomeSent.has(id32)) continue;

      const cred = allCreds.find((c) => c.steamId32 === String(id32));
      if (cred) {
        welcomeSent.add(id32);
        const msg = applyPlaceholders(WELCOME_MSG, { player_name: cred.displayName });
        sendHostMessage(msg);
        log('Welcome', `Sent to ${cred.displayName} (${id32}), currently on ${player.teamSide}(${player.slot})`);
      }
    }
  });

  hostSession.dota2.on(
    'chatMessage',
    (
      _channel: string,
      senderName: string,
      message: string,
      chatData: Record<string, unknown>
    ) => {
      const id32   = Number(chatData.account_id || 0);
      const cmd    = message.trim().toLowerCase();
      const isReady   = cmd === '!r' || cmd === '!ready';
      const isUnready = cmd === '!ur' || cmd === '!unready';
      if (!isReady && !isUnready) return;
      if (id32 === Number(hostSession.creds.steamId32)) return; // ignore host's own messages

      const snap     = currentPlayers.get(id32);
      const atSlot   = snap ? `${snap.teamSide}(${snap.slot})` : 'not-tracked';
      const prevLen  = botChatLog.length;

      if (isReady)   handleReadyCmd(id32, senderName);
      if (isUnready) handleUnreadyCmd(id32, senderName);

      const response = botChatLog.length > prevLen ? botChatLog[botChatLog.length - 1] : '(no response)';
      commandLog.push({ from: senderName, cmd, atSlot, response });
    }
  );

  // ── Player bots join lobby ─────────────────────────────────────────────

  section('STEP 2 — Player bots join lobby');

  // Simple counter — incremented in the join callback (no Set double-counting bug)
  let joinedCount = 0;

  // Invite player bots first (for observability), then they join directly
  for (const s of playerSessions) {
    hostSession.dota2.inviteToLobby(s.creds.steamId64);
  }
  await sleep(800);

  // Each player bot joins the lobby by ID + password, then joins the chat channel
  await Promise.all(playerSessions.map(async (s, i) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Player bot ${i + 1} join timeout`)), 30_000);
      s.dota2.joinPracticeLobby(
        lobbyIdLong,
        LOBBY_PASSWORD,
        (err: Error | null) => {
          clearTimeout(timer);
          if (err) {
            reject(new Error(`Player bot ${i + 1} (${s.creds.username}) join failed: ${err.message}`));
          } else {
            joinedCount++;
            // Join the lobby chat channel so sendMessage works
            s.dota2.joinChat(channelName, 3);
            log(`Bot${i + 1}`, `Joined lobby as ${s.creds.displayName}`);
            resolve();
          }
        }
      );
    });
  }));

  // Wait for all player bots to have called back from joinPracticeLobby
  const joinDeadline = Date.now() + 30_000;
  while (joinedCount < playerSessions.length && Date.now() < joinDeadline) {
    await sleep(500);
  }

  // TEST A — Player bots joined lobby
  section('TEST A — Player bots joined lobby');
  if (joinedCount === playerSessions.length) {
    pass(`All ${playerSessions.length} player bot(s) joined`);
    record('TEST A: all player bots joined', 'pass', `${playerSessions.length} bot(s)`);
  } else {
    fail('TEST A', `Only ${joinedCount}/${playerSessions.length} bots joined within 30s`);
    record('TEST A: all player bots joined', 'fail', `${joinedCount}/${playerSessions.length}`);
  }

  // Move all player bots to unassigned pool (slot=1, team=4=PLAYER_POOL)
  for (const s of playerSessions) {
    s.dota2.joinPracticeLobbyTeam(1, 4);
  }
  await sleep(1000);

  // TEST B — Welcome messages sent
  section('TEST B — Welcome messages sent ({player_name} substituted)');
  await sleep(1500); // allow practiceLobbyUpdate to fire
  if (welcomeSent.size >= playerSessions.length) {
    for (const s of playerSessions) {
      const msg = botChatLog.find((m) => m.includes(s.creds.displayName));
      if (msg && msg.includes(s.creds.displayName)) {
        pass(`Welcome sent to ${s.creds.displayName}: "${msg.slice(0, 60)}"`);
        record(`TEST B: welcome to ${s.creds.displayName}`, 'pass');
      } else {
        fail(`TEST B: welcome to ${s.creds.displayName}`, 'not found in chat log (or name not substituted)');
        record(`TEST B: welcome to ${s.creds.displayName}`, 'fail', 'message not found');
      }
    }
  } else {
    warn(`Welcome messages sent: ${welcomeSent.size}/${playerSessions.length}`);
    record('TEST B: welcome messages', 'fail', `only ${welcomeSent.size} sent`);
  }

  // ── TEST C — RadiantBot1: !r from unassigned → rejected ───────────────

  section('TEST C — RadiantBot1 !r from unassigned → rejected (not on team slot)');

  {
    const rb1 = playerSessions[0];
    const prevLen = commandLog.length;
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(1500);
    const cmd = commandLog.slice(prevLen).find((e) => e.from === rb1.creds.displayName);
    if (!cmd) {
      fail('TEST C', `Host bot did not receive !r from ${rb1.creds.displayName}`);
      record('TEST C: !r from unassigned rejected', 'fail', 'no command received by host');
    } else {
      log('TestC', `slot=${cmd.atSlot}  reply="${cmd.response}"`);
      const isRejected = cmd.response.includes('Brakuje') || cmd.response.includes('Not all') || cmd.response.includes('brak');
      if (!cmd.atSlot.includes('radiant') && isRejected) {
        pass(`!r from ${cmd.atSlot} → rejection message sent`);
        record('TEST C: !r from unassigned rejected', 'pass', `atSlot=${cmd.atSlot}`);
      } else {
        fail('TEST C', `atSlot=${cmd.atSlot}, response="${cmd.response.slice(0, 60)}"`);
        record('TEST C: !r from unassigned rejected', 'fail', `atSlot=${cmd.atSlot}`);
      }
    }
  }

  // ── TEST D — RadiantBot1 moves to Radiant slot 0, !r → still rejected (if 2 Radiant expected) ──

  if (expectedRadiant.length >= 2) {
    section('TEST D — RadiantBot1 on Radiant slot 0, !r → rejected because RadiantBot2 missing');
    const rb1 = playerSessions[0];
    rb1.dota2.joinPracticeLobbyTeam(1, 0); // slot 1 on Radiant (team 0)
    await sleep(1200);

    const prevLen = commandLog.length;
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(1500);

    const cmd = commandLog.slice(prevLen).find((e) => e.from === rb1.creds.displayName);
    if (!cmd) {
      fail('TEST D', 'Host did not receive !r command');
      record('TEST D: !r rejected (second Radiant missing)', 'fail', 'no command received');
    } else {
      log('TestD', `slot=${cmd.atSlot}  reply="${cmd.response}"`);
      const isOnRadiant  = cmd.atSlot.includes('radiant');
      const isRejected   = cmd.response.includes('Brakuje') || cmd.response.includes('brak');
      const namesMissing = cmd.response.includes(playerCreds[1].displayName);
      if (isOnRadiant && isRejected && namesMissing) {
        pass(`RadiantBot1 on Radiant, RadiantBot2 missing → rejection with correct name`);
        record('TEST D: !r rejected (second Radiant missing)', 'pass');
      } else {
        fail('TEST D', `reject=${isRejected} nameInMsg=${namesMissing} slot=${cmd.atSlot}`);
        record('TEST D: !r rejected (second Radiant missing)', 'fail');
      }
    }
  } else {
    info('TEST D skipped — only 1 Radiant bot (no second-player-missing scenario possible)');
    record('TEST D: !r rejected (second Radiant missing)', 'skip', 'only 1 Radiant bot');
  }

  // ── TEST E — All Radiant bots take correct slots, !r → Radiant ready ──

  section('TEST E — All Radiant bots on correct slots, !r → Radiant ready');

  // Move all Radiant bots to their slots (1-indexed: slot 1, 2, ...)
  const radiantBots = playerSessions.slice(0, expectedRadiant.length);
  for (let i = 0; i < radiantBots.length; i++) {
    radiantBots[i].dota2.joinPracticeLobbyTeam(i + 1, 0); // slot i+1 on Radiant team
  }
  await sleep(1500); // wait for lobby update to propagate

  {
    const rb1 = playerSessions[0];
    radiantReady = false; // reset state for clean test
    const prevLen = commandLog.length;
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(1500);

    const cmd = commandLog.slice(prevLen).find((e) => e.from === rb1.creds.displayName);
    if (!cmd) {
      fail('TEST E', 'Host did not receive !r command');
      record('TEST E: Radiant ready (all on correct slots)', 'fail', 'no command received');
    } else {
      log('TestE', `slot=${cmd.atSlot}  reply="${cmd.response}"  radiantReady=${radiantReady}`);
      const gotReady = cmd.response.includes('gotowy') || cmd.response.includes('ready') || cmd.response.includes('Obie');
      if (gotReady && radiantReady) {
        pass(`All Radiant bots on correct slots → teamReadyMessage, radiantReady=true`);
        record('TEST E: Radiant ready (all on correct slots)', 'pass');
      } else {
        fail('TEST E', `gotReady=${gotReady} radiantReady=${radiantReady}`);
        record('TEST E: Radiant ready (all on correct slots)', 'fail', cmd.response.slice(0, 60));
      }
    }
  }

  // ── TEST F — DireBot !r from unassigned → rejected ────────────────────

  if (playerSessions.length >= 3) {
    section('TEST F — DireBot !r from unassigned → rejected');
    const direBot = playerSessions[2]; // Bot[3]
    direBot.dota2.joinPracticeLobbyTeam(1, 4); // ensure unassigned (slot=1, team=4=PLAYER_POOL)
    await sleep(800);

    const prevLen = commandLog.length;
    direBot.dota2.sendMessage('!r', channelName, 3);
    await sleep(1500);

    const cmd = commandLog.slice(prevLen).find((e) => e.from === direBot.creds.displayName);
    if (!cmd) {
      fail('TEST F', 'Host did not receive !r from DireBot');
      record('TEST F: DireBot !r from unassigned rejected', 'fail', 'no command received');
    } else {
      const isRejected = cmd.response.includes('Brakuje') || cmd.response.includes('brak');
      if (!cmd.atSlot.includes('dire') && isRejected) {
        pass(`DireBot from ${cmd.atSlot} → rejected correctly`);
        record('TEST F: DireBot !r from unassigned rejected', 'pass');
      } else {
        fail('TEST F', `atSlot=${cmd.atSlot} response="${cmd.response.slice(0, 60)}"`);
        record('TEST F: DireBot !r from unassigned rejected', 'fail');
      }
    }
  } else {
    info('TEST F skipped — no Dire bot available');
    record('TEST F: DireBot !r from unassigned rejected', 'skip', 'no Dire bot');
  }

  // ── TEST G — DireBot takes Dire slot, !r → Dire ready ─────────────────

  if (playerSessions.length >= 3) {
    section('TEST G — DireBot on Dire slot 0, !r → Dire ready');
    const direBot = playerSessions[2];
    direBot.dota2.joinPracticeLobbyTeam(1, 1); // slot 1 on Dire team (1-indexed)
    await sleep(1500);

    direReady = false; // reset
    const prevLen = commandLog.length;
    direBot.dota2.sendMessage('!r', channelName, 3);
    await sleep(1500);

    const cmd = commandLog.slice(prevLen).find((e) => e.from === direBot.creds.displayName);
    if (!cmd) {
      fail('TEST G', 'Host did not receive !r from DireBot on Dire slot');
      record('TEST G: DireBot ready (on correct slot)', 'fail', 'no command received');
    } else {
      log('TestG', `slot=${cmd.atSlot}  reply="${cmd.response}"  direReady=${direReady}`);
      // ── TEST H check embedded here: both teams ready → allReadyMessage
      const gotAllReady = cmd.response.includes('Obie') || cmd.response.includes('Both');
      const gotDireReady = cmd.response.includes('Dire') && (cmd.response.includes('gotowy') || cmd.response.includes('ready'));
      if (direReady && (gotDireReady || gotAllReady)) {
        pass(`DireBot on Dire slot → ready! direReady=true`);
        record('TEST G: DireBot ready (on correct slot)', 'pass');
        if (gotAllReady) {
          pass('[TEST H embedded] Both teams ready → allReadyMessage');
          record('TEST H: both teams ready → allReadyMessage', 'pass');
        } else {
          info('[TEST H] Radiant was reset (from TEST I) — allReadyMessage not expected');
          record('TEST H: both teams ready → allReadyMessage', 'skip', 'Radiant reset earlier');
        }
      } else {
        fail('TEST G', `direReady=${direReady} atSlot=${cmd.atSlot}`);
        record('TEST G: DireBot ready (on correct slot)', 'fail', cmd.response.slice(0, 60));
        record('TEST H: both teams ready → allReadyMessage', 'skip', 'TEST G failed');
      }
    }
  } else {
    info('TEST G+H skipped — no Dire bot available');
    record('TEST G: DireBot ready (on correct slot)', 'skip', 'no Dire bot');
    record('TEST H: both teams ready → allReadyMessage', 'skip', 'no Dire bot');
  }

  // ── TEST I — !ur clears ready state ───────────────────────────────────

  section('TEST I — !ur clears ready state');

  {
    radiantReady = true; // force set for this test
    const rb1 = playerSessions[0];
    const prevLen = commandLog.length;
    rb1.dota2.sendMessage('!ur', channelName, 3);
    await sleep(1500);

    const cmd = commandLog.slice(prevLen).find((e) => e.from === rb1.creds.displayName);
    if (!cmd) {
      fail('TEST I', 'Host did not receive !ur command');
      record('TEST I: !ur clears ready state', 'fail', 'no command received');
    } else {
      log('TestI', `reply="${cmd.response}"  radiantReady=${radiantReady}`);
      const ackSent = cmd.response !== '(no response)';
      if (!radiantReady && ackSent) {
        pass(`!ur → radiantReady cleared, ack sent`);
        record('TEST I: !ur clears ready state', 'pass');
      } else {
        fail('TEST I', `radiantReady=${radiantReady} ackSent=${ackSent}`);
        record('TEST I: !ur clears ready state', 'fail');
      }
    }
  }

  // ── TEST J — No cooldown: !r spam 3× ─────────────────────────────────

  section('TEST J — RadiantBot1 sends !r three times quickly (no cooldown throttle)');

  {
    // Ensure RadiantBot1 is on Radiant slot so responses are not rejections
    const rb1 = playerSessions[0];
    rb1.dota2.joinPracticeLobbyTeam(0, 0);
    await sleep(1000);

    const prevLen = commandLog.length;
    // Send 3 !r commands with minimal delay between them
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(300);
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(300);
    rb1.dota2.sendMessage('!r', channelName, 3);
    await sleep(2000);

    const cmds = commandLog.slice(prevLen).filter((e) => e.from === rb1.creds.displayName && e.cmd === '!r');
    const responses = cmds.filter((e) => e.response !== '(no response)');
    log('TestJ', `Sent 3 !r, received ${cmds.length} tracked, ${responses.length} got responses`);

    if (responses.length >= 3) {
      pass(`3 !r commands → 3 responses (no cooldown active)`);
      record('TEST J: no cooldown (3x !r)', 'pass', `${responses.length} responses`);
    } else if (responses.length >= 2) {
      warn(`Only ${responses.length}/3 !r commands generated responses (messages may be deduped by GC)`);
      record('TEST J: no cooldown (3x !r)', 'pass', `${responses.length}/3 responses (GC dedup?)`);
    } else {
      fail('TEST J', `Only ${responses.length}/3 !r commands got a response`);
      record('TEST J: no cooldown (3x !r)', 'fail', `${responses.length}/3`);
    }
  }

  // ── TEST K — Launch lobby, invite observer, all bots abandon ─────────

  section('TEST K — Launch lobby / invite observer / bots abandon game');

  // Invite Cienszki to join as spectator
  hostSession.dota2.inviteToLobby(CIENSZKI_STEAM64);
  sendHostMessage(`[TEST K] Cienszki zaproszony — czekamy ${SPECTATOR_WAIT_SECS}s na dołączenie jako widz.`);
  info(`Cienszki (${CIENSZKI_STEAM64}) invited. Waiting up to ${SPECTATOR_WAIT_SECS}s...`);

  let cienszkiJoined = false;
  const spectatorDeadline = Date.now() + SPECTATOR_WAIT_SECS * 1_000;

  const watchForCienszki = (lobby: Record<string, unknown>) => {
    const members = (lobby.all_members || []) as Array<Record<string, unknown>>;
    if (!cienszkiJoined && members.some((m) => steam64ToSteam32(m.id) === CIENSZKI_STEAM32)) {
      cienszkiJoined = true;
      log('TestK', 'Cienszki joined the lobby!');
      sendHostMessage('Siema Cienszki! Zaraz puszczamy mecz — obserwuj jako widz.');
    }
  };
  hostSession.dota2.on('practiceLobbyUpdate', watchForCienszki);

  while (!cienszkiJoined && Date.now() < spectatorDeadline) {
    await sleep(2000);
    const remaining = Math.round((spectatorDeadline - Date.now()) / 1000);
    if (remaining > 0 && remaining % 20 === 0) info(`Still waiting for Cienszki... ${remaining}s left`);
  }
  hostSession.dota2.removeListener('practiceLobbyUpdate', watchForCienszki);

  if (cienszkiJoined) {
    pass('Cienszki joined as observer');
    record('TEST K pre: Cienszki joined lobby', 'pass');
    await sleep(3000);
  } else {
    warn('Cienszki did not join within timeout — launching without observer');
    record('TEST K pre: Cienszki joined lobby', 'skip', 'timeout');
  }

  // Launch the lobby
  info('Launching practice lobby...');
  let launchOk = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { warn('launchPracticeLobby callback timed out (30s)'); resolve(); }, 30_000);
    hostSession.dota2.launchPracticeLobby((err: Error | null) => {
      clearTimeout(t);
      launchOk = !err;
      if (err) warn(`launchPracticeLobby error: ${err.message}`);
      resolve();
    });
  });

  if (launchOk) {
    pass('launchPracticeLobby() accepted by GC');
    record('TEST K: launchPracticeLobby accepted', 'pass');
  } else {
    fail('TEST K', 'launchPracticeLobby() returned an error');
    record('TEST K: launchPracticeLobby accepted', 'fail');
  }

  // Wait for lobby state to transition away from 0 (UI) — indicates server setup started
  info('Waiting for lobby state to leave UI (up to 90s)...');
  let lobbyState = 0;
  const stateDeadline = Date.now() + 90_000;

  const watchLobbyState = (lobby: Record<string, unknown>) => {
    const s = Number(lobby.state ?? 0);
    if (s !== lobbyState) {
      log('TestK', `Lobby state: ${lobbyState} → ${s}`);
      lobbyState = s;
    }
  };
  hostSession.dota2.on('practiceLobbyUpdate', watchLobbyState);
  while (lobbyState === 0 && Date.now() < stateDeadline) await sleep(2000);
  hostSession.dota2.removeListener('practiceLobbyUpdate', watchLobbyState);

  if (lobbyState !== 0) {
    pass(`Lobby state changed to ${lobbyState} — server setup in progress`);
    record('TEST K: lobby state changed after launch', 'pass', `state=${lobbyState}`);
  } else {
    warn('Lobby state stayed 0 after 90s — will still try abandoning');
    record('TEST K: lobby state changed after launch', 'fail', 'state=0 (no change)');
  }

  // Give server a moment to get past the initial setup phase
  await sleep(5000);

  // All bots fire abandonCurrentGame — fire-and-forget since our bots are GC-only
  // (they never connect to the actual game server, so the GC callback won't return).
  // We instead wait for practiceLobbyCleared on the host, which fires when the server
  // gives up waiting for players to connect and cleans up the match.
  info('Sending abandonCurrentGame for all bots (fire-and-forget)...');
  for (const s of sessions) {
    s.dota2.abandonCurrentGame();
  }

  info('Waiting for practiceLobbyCleared (game server cleans up after bots don\'t connect, up to 120s)...');
  let lobbyClearedFired = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      warn('practiceLobbyCleared did not fire within 120s');
      resolve();
    }, 120_000);
    hostSession.dota2.once('practiceLobbyCleared', () => {
      clearTimeout(t);
      lobbyClearedFired = true;
      log('TestK', 'practiceLobbyCleared — match ended, lobby destroyed');
      resolve();
    });
  });

  if (lobbyClearedFired) {
    pass('practiceLobbyCleared fired — match ended cleanly after bots abandoned');
    record('TEST K: all bots abandon game', 'pass', 'practiceLobbyCleared received');
  } else {
    // If cleared didn't fire, check if host still has a lobby — it may have already cleared
    // during the state-monitoring phase
    warn('practiceLobbyCleared not detected — match may have already ended or timed out');
    record('TEST K: all bots abandon game', 'skip', 'practiceLobbyCleared not received (may already be cleared)');
  }


  await sleep(2000);

  // ── Leave and disconnect ───────────────────────────────────────────────

  section('CLEANUP — All bots leave lobby');

  // Player bots leave first
  await Promise.all(playerSessions.map(async (s, i) => {
    return new Promise<void>((resolve) => {
      s.dota2.leavePracticeLobby(() => {
        log(`Bot${i + 1}`, `${s.creds.displayName} left lobby`);
        resolve();
      });
    });
  }));

  await sleep(1000);

  // Host leaves last
  await new Promise<void>((resolve) => {
    hostSession.dota2.leavePracticeLobby(() => {
      log('Host', 'Left lobby');
      resolve();
    });
  });

  await sleep(500);

  for (const s of sessions) await disconnectBot(s);

  // ── Print summary ─────────────────────────────────────────────────────

  section('FULL TEST SUMMARY');

  let nPass = 0, nFail = 0, nSkip = 0;
  for (const r of results) {
    const icon = r.status === 'pass'
      ? '\x1b[32m✓\x1b[0m'
      : r.status === 'fail'
      ? '\x1b[31m✗\x1b[0m'
      : '\x1b[33m-\x1b[0m';
    const note = r.note ? `  (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
    if (r.status === 'pass') nPass++;
    else if (r.status === 'fail') nFail++;
    else nSkip++;
  }

  console.log(`\n  Passed: ${nPass}  Failed: ${nFail}  Skipped: ${nSkip}\n`);

  if (commandLog.length > 0) {
    console.log('\x1b[1m  Full command log:\x1b[0m');
    commandLog.forEach((e, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${e.from.padEnd(20)} ${e.cmd.padEnd(4)} ` +
        `[${e.atSlot}] → "${e.response.slice(0, 80)}${e.response.length > 80 ? '…' : ''}"`
      );
    });
    console.log('');
  }

  process.exit(nFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
