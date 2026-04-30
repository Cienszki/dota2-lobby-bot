/**
 * Two-Player Launch Test — Cienszki + Pupa
 *
 * Tests the full match-start flow with TWO real human players:
 *   A — Both receive GC invite + Steam friend message
 *   B — Both join the lobby (playerJoined events fire)
 *   C — Welcome message sent per player with {player_name} substitution
 *   D — !r while spectator/unassigned → rejected (must sit in any player slot)
 *   E — Both in player slots on OPPOSING sides + both type !r → accepted
 *        (which player is Radiant vs Dire is flexible — just must be different)
 *   E2 — Bot checks both teams have selected a team name from the dropdown
 *         ("The Radiant"/"The Dire" defaults are rejected; real team name required)
 *   F — Bot calls startGame() with selectionPriorityRules=0 (coin toss)
 *   G — coinTossResult event fires (priority team determined by GC)
 *   H — Bot informs players to pick side/priority in lobby UI
 *   I — coinTossSelectionComplete fires (both players chose) → game launches
 *
 * SIDE-SELECTION CLARIFICATION:
 * The Radiant/Dire SLOT a player occupies is just a lobby seat — it does NOT
 * determine which in-game faction they play. That is chosen AFTER the coin toss
 * in the priority-selection UI. However, Dota 2 DOES require the two teams to
 * be on OPPOSING sides (one on Radiant slots, one on Dire slots) and both must
 * have selected a real team name (dropdown) before the game can be started.
 *
 * Testers:
 *   Cienszki — steamId32: 35747920  / steamId64: 76561197996013648
 *   Pupa     — steamId32: 111886752 / steamId64: 76561198072152480
 *
 * NOTE: With only 2 real players (no full 5v5), launchPracticeLobby may reject
 * the start if Valve's GC requires all 10 slots filled. This test records the
 * outcome either way — the primary goal is verifying the bot's !r handler and
 * coin-toss event pipeline work correctly with two separate real captains.
 *
 * Usage:
 *   npx tsx bot-worker/test-two-player-launch.ts
 *
 * Requires:
 *   STEAM_USERNAME and STEAM_PASSWORD in bot-worker/.env
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

import { DotaClient } from './src/dota-client.js';
import type { LobbyPlayerInfo, LobbyChatMessage } from './src/dota-client.js';
import * as readline from 'readline';

// ─── Tester identities ──────────────────────────────────────────────────────

const TESTERS = [
  { steam32: '35747920', steam64: '76561197996013648', name: 'Cienszki' },
  { steam32: '86741058', steam64: '76561198047006786', name: 'Sato'     },
] as const;

// Quick lookups
const TESTER_BY_32 = new Map<string, typeof TESTERS[number]>(TESTERS.map((t) => [t.steam32, t]));
const TESTER_BY_64 = new Map<string, typeof TESTERS[number]>(TESTERS.map((t) => [t.steam64, t]));

// ─── Lobby config ────────────────────────────────────────────────────────────

const LOBBY_NAME     = 'PD2IH Two-Player Launch Test';
const LOBBY_PASSWORD = 'pd2ihtest';

// ─── Chat message templates ──────────────────────────────────────────────────

// !r acceptance criteria:
//   1. Player is in a player slot (Radiant 0-4 or Dire 5-9), not spectator/unassigned
//   2. Once all players have typed !r, the two sides must be OPPOSING
//      (one player on Radiant slots, other on Dire slots)
// Which physical side each team occupies is flexible — coin toss decides the
// in-game faction assignment afterwards.
//
// Before startGame() the bot also checks both teams selected a real team name
// from the dropdown (not the default "The Radiant" / "The Dire" labels).
const MSG_WELCOME        = 'Witaj {player_name}! Usiądź na slocie gracza (lewa lub prawa strona) i napisz !r gdy gotowy.';
const MSG_NOT_IN_SLOT    = '{player_name}: Najpierw usiądź na slocie gracza (lewa lub prawa strona) — nie jako spektator.';
const MSG_PLAYER_READY   = '{player_name} gotowy po stronie {side}! Czekamy na {waiting}...';
const MSG_SAME_SIDE      = 'Obaj gracze są po stronie {side}! Jeden musi przejść na drugą stronę i ponownie napisać !r.';
const MSG_NEED_TEAMS     = 'Prawie! Każdy z graczy musi wybrać drużynę z dropdown (kliknij baner z nazwą nad slotami — nie "The Radiant"/"The Dire").';
const MSG_ALL_READY      = 'Obaj gotowi po przeciwnych stronach! Czekam na wybór drużyn, potem startuję coin toss...';
const MSG_UNREADY_ACK    = '{player_name}: Cofnięto gotowość.';
const MSG_COIN_TOSS_DONE = 'Coin toss zakończony! Drużyna z priorytetem wybiera stronę/kolejność w UI.';
const MSG_LAUNCH_DONE    = 'Gra wystartowała! GG.';

// ─── Ready state ────────────────────────────────────────────────────────────
// Tracks which lobby side each player was on when they confirmed !r.
// Updated on every !r call (player may re-try from a different slot).
// Cleared on !ur.
const playerReadySide = new Map<string, 'radiant' | 'dire'>();

// ─── Test results ─────────────────────────────────────────────────────────────

const results: { step: string; status: 'pass' | 'fail' | 'skip'; note?: string }[] = [];
function record(step: string, status: 'pass' | 'fail' | 'skip', note?: string): void {
  results.push({ step, status, note });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}
function pass(label: string): void {
  console.log(`\x1b[32m  ✓ PASS: ${label}\x1b[0m`);
}
function fail(label: string, reason?: string): void {
  console.log(`\x1b[31m  ✗ FAIL: ${label}${reason ? ' — ' + reason : ''}\x1b[0m`);
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
function waitForUser(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n\x1b[33m  ⏸  ${prompt} [Press Enter]\x1b[0m\n  `, () => { rl.close(); resolve(); });
  });
}
function waitForEvent<T>(
  emitter: { on: (e: string, cb: (a: T) => void) => void; removeListener: (e: string, cb: (a: T) => void) => void },
  event: string,
  timeoutMs: number,
  predicate?: (a: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`Timeout waiting for '${event}' (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    function handler(a: T): void {
      if (!predicate || predicate(a)) {
        clearTimeout(timer);
        emitter.removeListener(event, handler);
        resolve(a);
      }
    }
    emitter.on(event, handler);
  });
}

function applyPlaceholders(msg: string, ctx: Record<string, string>): string {
  return msg.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');
}

// ─── Ready-check logic ────────────────────────────────────────────────────────
//
// Step-by-step when a player types !r:
//   1. Must be in a player slot (Radiant 0-4 or Dire 5-9) — reject if spectator/unassigned
//   2. Record their current side (updates on every !r, so re-trying after switching is fine)
//   3. If not all testers have readied yet → acknowledge and wait
//   4. If all readied → check they are on OPPOSING sides
//      — same side: ask someone to switch and re-type !r
//      — opposing:  check both sides have a real team name selected, then fire onBothReady()
//
// Team name check is done at !r time — players are expected to select their
// team from the dropdown BEFORE pressing !r.
//
// "Which side each team occupies" is not predetermined — Cienszki may end up
// on Radiant or Dire, same for Pupa. Only constraint: they must be different.

const DEFAULT_TEAM_NAMES = new Set(['', 'the radiant', 'the dire', 'radiant', 'dire']);
function isTeamSelected(name: string): boolean {
  return !DEFAULT_TEAM_NAMES.has(name.trim().toLowerCase());
}

function getPlayerSide(players: LobbyPlayerInfo[], steam32: string): 'radiant' | 'dire' | null {
  const p = players.find((pl) => pl.steamId32 === steam32);
  if (!p || (p.team !== 'radiant' && p.team !== 'dire')) return null;
  return p.team;
}

function handleReadyCommand(
  accountId: number,
  senderName: string,
  players: LobbyPlayerInfo[],
  getTeamNames: () => { radiant: string; dire: string },
  sendMsg: (m: string) => Promise<void>,
  onBothReady: () => void
): void {
  const steam32 = String(accountId);
  if (!TESTER_BY_32.has(steam32)) {
    log('ReadyCheck', `!r from unrecognized player ${steam32} — ignored`);
    return;
  }

  // 1. Must be in a player slot
  const side = getPlayerSide(players, steam32);
  if (!side) {
    sendMsg(applyPlaceholders(MSG_NOT_IN_SLOT, { player_name: senderName })).catch(() => undefined);
    log('ReadyCheck', `!r from ${senderName} rejected — spectator/unassigned`);
    return;
  }

  // 2. Team name must already be selected for this player's side
  const teamNames = getTeamNames();
  const teamNameForSide = side === 'radiant' ? teamNames.radiant : teamNames.dire;
  log('ReadyCheck', `!r from ${senderName} — ${side} team name: "${teamNameForSide}"`);
  if (!isTeamSelected(teamNameForSide)) {
    sendMsg(MSG_NEED_TEAMS).catch(() => undefined);
    log('ReadyCheck', `!r from ${senderName} rejected — ${side} side has no team name selected`);
    return;
  }

  // 3. Record their side (overwrite if they switched and re-typed !r)
  playerReadySide.set(steam32, side);
  log('ReadyCheck',
    `${senderName} on ${side} (team: "${teamNameForSide}") — state: ${
      [...playerReadySide.entries()].map(([id, s]) => `${TESTER_BY_32.get(id)?.name ?? id}=${s}`).join(', ')
    }`
  );

  // 4. Check if all testers have now readied
  const notReady = TESTERS.filter((t) => !playerReadySide.has(t.steam32));
  if (notReady.length > 0) {
    const waiting = notReady.map((t) => t.name).join(', ');
    sendMsg(applyPlaceholders(MSG_PLAYER_READY, { player_name: senderName, side, waiting })).catch(() => undefined);
    return;
  }

  // 5. All readied — verify CURRENT (live) opposing sides.
  // Re-read live positions so a player who moved after pressing !r is checked at
  // their actual current slot, not the stale cached value.
  const radiantIds: string[] = [];
  const direIds: string[]    = [];
  for (const [id] of playerReadySide) {
    const liveSide = getPlayerSide(players, id);
    if (liveSide === 'radiant') {
      radiantIds.push(id);
      playerReadySide.set(id, 'radiant');
    } else if (liveSide === 'dire') {
      direIds.push(id);
      playerReadySide.set(id, 'dire');
    } else {
      // Player moved to spectator/unassigned after pressing !r
      playerReadySide.delete(id);
      const name = TESTER_BY_32.get(id)?.name ?? id;
      sendMsg(applyPlaceholders(MSG_NOT_IN_SLOT, { player_name: name })).catch(() => undefined);
      log('ReadyCheck', `${name} left player slot after !r — ready state cleared`);
      return;
    }
  }

  if (radiantIds.length === 0 || direIds.length === 0) {
    const sameSide = radiantIds.length === 0 ? 'dire' : 'radiant';
    sendMsg(applyPlaceholders(MSG_SAME_SIDE, { side: sameSide })).catch(() => undefined);
    log('ReadyCheck', `All on ${sameSide} — asked someone to switch and re-type !r`);
    return; // ← wait for re-!r after side switch
  }

  // 6. Opposing sides confirmed
  log('ReadyCheck',
    `Opposing sides OK — Radiant:[${radiantIds.map((id) => TESTER_BY_32.get(id)?.name ?? id).join(',')}]` +
    ` Dire:[${direIds.map((id) => TESTER_BY_32.get(id)?.name ?? id).join(',')}]`
  );
  const finalNames = getTeamNames();
  sendMsg(`Gotowi! ${finalNames.radiant} (Radiant) vs ${finalNames.dire} (Dire) — startuję coin toss!`).catch(() => undefined);
  onBothReady();
}

function handleUnreadyCommand(
  accountId: number,
  senderName: string,
  sendMsg: (m: string) => Promise<void>
): void {
  const steam32 = String(accountId);
  if (!TESTER_BY_32.has(steam32)) return;

  playerReadySide.delete(steam32);
  sendMsg(applyPlaceholders(MSG_UNREADY_ACK, { player_name: senderName })).catch(() => undefined);
  const stillReady = [...playerReadySide.entries()]
    .map(([id, s]) => `${TESTER_BY_32.get(id)?.name ?? id}=${s}`).join(', ');
  log('ReadyCheck', `${senderName} unreadied — still ready: ${stillReady || 'nobody'}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const username = process.env.STEAM_USERNAME;
  const password = process.env.STEAM_PASSWORD;
  if (!username || !password) {
    console.error('ERROR: Set STEAM_USERNAME and STEAM_PASSWORD in bot-worker/.env');
    process.exit(1);
  }

  console.log('\x1b[1m\nPD2IH Bot — Two-Player Launch Test\x1b[0m');
  console.log(`Bot account : ${username}`);
  console.log(`Team Radiant: ${TESTERS[0].name} (Steam32: ${TESTERS[0].steam32})`);
  console.log(`Team Dire   : ${TESTERS[1].name} (Steam32: ${TESTERS[1].steam32})`);
  console.log(`Lobby       : "${LOBBY_NAME}"  password: ${LOBBY_PASSWORD}`);
  info('coin toss mode is ON (selectionPriorityRules=1) — players will see "pick side or order" UI after launch');

  const client = new DotaClient({ username, password });

  // ── STEP 1: Connect ──────────────────────────────────────────────────────
  section('STEP 1 — Connect to Steam + Dota 2 GC');
  try {
    await client.connect();
    pass('Steam login + GC ready');
    record('connect()', 'pass');
  } catch (err) {
    fail('connect()', String(err));
    record('connect()', 'fail', String(err));
    process.exit(1);
  }

  // ── STEP 2: Create lobby (coin toss mode) ────────────────────────────────
  section('STEP 2 — Create lobby (selectionPriorityRules=0 / coin toss)');
  try {
    await client.createLobby({
      name: LOBBY_NAME,
      password: LOBBY_PASSWORD,
      gameMode: 2,          // All Pick
      serverRegion: 3,      // Europe
      visibility: 0,        // Public (password still required to join)
      dotaTvDelay: 120,
      seriesType: 0,
      cheatsEnabled: false,
      fillWithBots: false,
      allowSpectators: true,
      pauseSetting: 1,
      selectionPriorityRules: 1,  // ← 1=Automatic (Coin Toss): players pick side/priority after flip
    });
    pass('Lobby created (coin toss mode) — bot in unassigned pool');
    record('createLobby()', 'pass');
  } catch (err) {
    fail('createLobby()', String(err));
    record('createLobby()', 'fail', String(err));
    await client.disconnect();
    process.exit(1);
  }

  // ── STEP 3: Configure teams + invite both players ────────────────────────
  section('STEP 3 — Configure session teams + invite both players');

  // Only the 2 real players are allowed — everyone else gets auto-kicked.
  // Which physical side each ends up on is NOT pre-assigned; they choose freely.
  client.setSessionTeams(
    [TESTERS[0].steam32],   // Team A = Cienszki
    [TESTERS[1].steam32],   // Team B = Pupa
  );
  info(`Teams: [${TESTERS[0].name}] vs [${TESTERS[1].name}]`);
  info('Both can sit on either Radiant or Dire slots — they just need to be on OPPOSING sides');
  info('Auto-kick is ACTIVE — any other player who joins will be removed immediately');

  // Wire up lobby update listener for welcome messages before inviting
  const welcomeSent = new Set<string>();
  client.on('playerJoined', async (data: { accountId: number; steamId64: string }) => {
    const tester = TESTER_BY_64.get(data.steamId64);
    if (!tester || welcomeSent.has(tester.steam32)) return;
    welcomeSent.add(tester.steam32);

    const msg = applyPlaceholders(MSG_WELCOME, { player_name: tester.name });
    await client.sendChatMessage(msg);
    log('Welcome', `→ ${tester.name}: "${msg}"`);
  });

  // Invite both players (GC bell + Steam friend message)
  for (const t of TESTERS) {
    await client.invitePlayer(t.steam32);
    info(`Invite sent to ${t.name} (${t.steam32})`);
    await sleep(600);
  }

  pass('Invites sent to both players');
  record('invitePlayers()', 'pass');

  // ── STEP 4: Wait for both players to join ────────────────────────────────
  section('STEP 4 — Waiting for BOTH players to join (10 min timeout)');
  info(`Lobby: "${LOBBY_NAME}"  password: ${LOBBY_PASSWORD}`);

  const joined = new Set<string>();
  const JOIN_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  // Seed from current players in case they were already in the lobby
  // (e.g. bot reconnected to an existing lobby — events fired before this listener)
  for (const p of client.getCurrentLobbyPlayers()) {
    const tester = TESTER_BY_32.get(p.steamId32);
    if (tester) {
      joined.add(tester.steam32);
      log('Join', `${tester.name} already in lobby (pre-seeded)`);
    }
  }

  client.on('playerJoined', (data: { accountId: number; steamId64: string }) => {
    const tester = TESTER_BY_64.get(data.steamId64);
    if (tester) {
      joined.add(tester.steam32);
      log('Join', `${tester.name} joined lobby (${joined.size}/2)`);
    }
  });

  const joinDeadline = Date.now() + JOIN_TIMEOUT;
  while (joined.size < TESTERS.length && Date.now() < joinDeadline) {
    const remaining   = TESTERS.filter((t) => !joined.has(t.steam32)).map((t) => t.name);
    log('Waiting', `Still waiting for: ${remaining.join(', ')}  (${Math.round((joinDeadline - Date.now()) / 1000)}s left)`);
    await sleep(5000);
  }

  if (joined.size < TESTERS.length) {
    const missing = TESTERS.filter((t) => !joined.has(t.steam32)).map((t) => t.name).join(', ');
    fail(`Players did not join in time`, `missing: ${missing}`);
    record('Both players join', 'fail', `missing: ${missing}`);
    await client.disconnect();
    process.exit(1);
  }

  pass(`Both players joined: ${TESTERS.map((t) => t.name).join(', ')}`);
  record('Both players join', 'pass');

  // TEST B: welcome messages were sent
  for (const t of TESTERS) {
    if (welcomeSent.has(t.steam32)) {
      pass(`TEST B: welcome sent to ${t.name}`);
      record(`TEST B: welcome ${t.name}`, 'pass');
    } else {
      fail(`TEST B: welcome NOT sent to ${t.name}`);
      record(`TEST B: welcome ${t.name}`, 'fail', 'playerJoined fired but welcome skipped');
    }
  }

  // ── STEP 5: Attach !r / !ur chat handler ────────────────────────────────
  section('STEP 5 — !r / !ur chat handler active');

  const READY_CMDS   = new Set(['!r', '!ready']);
  const UNREADY_CMDS = new Set(['!ur', '!unready']);

  // Fired when both teams are ready — resolves the bothReadyPromise below
  let bothReadyResolve!: () => void;
  const bothReadyPromise = new Promise<void>((res) => { bothReadyResolve = res; });

  client.on('chatMessage', (msg: LobbyChatMessage) => {
    const cmd = msg.message.trim().toLowerCase();
    const players = client.getCurrentLobbyPlayers();

    if (READY_CMDS.has(cmd)) {
      log('Chat', `!r from ${msg.playerName} (Steam32: ${msg.steamId32})`);
      // Dump raw lobby keys once to discover actual GC team-name field names
      const rawLobby = client.getRawLobby();
      if (rawLobby) {
        const keys = Object.keys(rawLobby).join(', ');
        log('LobbyKeys', `Top-level keys: ${keys}`);
        // Also log any key that contains "team" or "name"
        const teamKeys = Object.entries(rawLobby)
          .filter(([k]) => /team|name/i.test(k))
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join('; ');
        if (teamKeys) log('LobbyKeys', `team/name fields: ${teamKeys}`);
      }
      handleReadyCommand(
        msg.accountId,
        msg.playerName,
        players,
        () => client.getLobbyTeamNames(),
        (m) => client.sendChatMessage(m),
        bothReadyResolve
      );
    } else if (UNREADY_CMDS.has(cmd)) {
      log('Chat', `!ur from ${msg.playerName} (Steam32: ${msg.steamId32})`);
      handleUnreadyCommand(msg.accountId, msg.playerName, (m) => client.sendChatMessage(m));
    }
  });

  info('Instructions sent to players via lobby chat:');
  await client.sendChatMessage(`=== TEST READY CHECK ===`);
  await sleep(600);
  await client.sendChatMessage(`Każdy gracz: (1) usiądź na slocie, (2) wybierz drużynę z dropdown nad slotami, (3) napisz !r.`);
  await sleep(600);
  await client.sendChatMessage(`Musicie być po PRZECIWNYCH stronach i obie drużyny muszą mieć wybrane nazwy zanim !r zostanie przyjęte.`);

  // ── STEP 6: Wait for both players to !r from opposing slots ────────────
  section('STEP 6 — Waiting for both players to !r (opposing sides, 10 min timeout)');
  info('Each player sits in any player slot; bot accepts once they are on OPPOSING sides');

  const readyTimeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 10 * 60 * 1000));
  const raceResult   = await Promise.race([bothReadyPromise.then(() => 'ready' as const), readyTimeout]);

  if (raceResult === 'timeout') {
    fail('Both teams ready on opposing sides', 'timeout after 10 min');
    record('TEST E: both players !r on opposing sides', 'fail', 'timeout');
    await client.disconnect();
    process.exit(1);
  }

  pass('Both players ready on opposing sides + team names selected');
  record('TEST E: both players !r (opposing sides + team names)', 'pass');

  // ── STEPS 7-9: startGame() + coin toss phases ──────────────────────────
  // IMPORTANT: Set up event listeners BEFORE calling startGame() to avoid a
  // race condition — both events can fire during the practiceLobbyUpdate that
  // arrives synchronously alongside the launchPracticeLobby GC response.

  // coinTossResult fires if GC reports a non-zero priority team ID (requires leagueid).
  // Without leagueid it will timeout — that is expected and we skip rather than fail.
  const coinTossResultPromise = waitForEvent<{ priorityTeamId: string; priorityTeamId32: number }>(
    client, 'coinTossResult', 30_000
  ).catch(() => null); // null = timed out (no leagueid)

  // coinTossSelectionComplete fires once both teams chose side/pick-order in the UI.
  const coinTossSelectionPromise = waitForEvent<{ priorityChoice: number; nonPriorityChoice: number }>(
    client, 'coinTossSelectionComplete', 3 * 60_000
  );

  section('STEP 7 — startGame() — triggering coin toss (Phase 1)');

  try {
    await client.startGame();
    pass('startGame() succeeded — coin toss Phase 1 initiated');
    record('TEST F: startGame() coin toss', 'pass');
  } catch (err) {
    // launchPracticeLobby may fail if GC requires all 10 slots filled
    fail(`startGame() failed`, String(err));
    record('TEST F: startGame() coin toss', 'fail', String(err));
    info('NOTE: Dota 2 GC may require 10 players (5v5) to launch. With 2 real players');
    info('      the game might not start — this is expected behaviour, not a bot bug.');
    await client.sendChatMessage(`Nie udało się wystartować: ${String(err)} — GC może wymagać 10 graczy.`);
    await sleep(5000);
    await client.disconnect();
    printSummary();
    process.exit(0);
  }

  // ── STEP 8: Coin toss result (who won — requires leagueid for team ID) ──
  section('STEP 8 — Coin toss result (coinTossResult event)');
  info('Priority team ID is only set by GC when a leagueid is assigned to the lobby.');
  info('Without leagueid this is skipped — the coin toss still runs, selections still work.');

  const coinResult = await coinTossResultPromise;
  if (coinResult) {
    const winner  = TESTER_BY_32.get(String(coinResult.priorityTeamId32));
    const winName = winner ? winner.name : `Steam32=${coinResult.priorityTeamId32}`;
    pass(`coinTossResult: priority team is ${winName} (id32=${coinResult.priorityTeamId32})`);
    record('TEST G: coinTossResult event', 'pass', `winner=${winName}`);
    log('CoinToss', `Priority team id32: ${coinResult.priorityTeamId32}`);
    await client.sendChatMessage(MSG_COIN_TOSS_DONE);
    await sleep(600);
    await client.sendChatMessage(`Drużyna z priorytetem: ${winName} — wybierz stronę/kolejność w UI.`);
  } else {
    record('TEST G: coinTossResult event', 'skip', 'no leagueid — priority team ID not set by GC');
    log('CoinToss', 'coinTossResult skipped — no leagueid (expected in test environment)');
  }

  // ── STEP 9: Wait for selection complete → game launches ─────────────────
  section('STEP 9 — Waiting for both players to pick side/priority (coinTossSelectionComplete)');
  info('Each player should now see the priority selection UI in the Dota 2 lobby.');
  info('Once both choose, the bot fires Phase 2 (second launchPracticeLobby) automatically.');

  try {
    const selResult = await coinTossSelectionPromise;
    pass(`coinTossSelectionComplete: priorityChoice=${selResult.priorityChoice} nonPriorityChoice=${selResult.nonPriorityChoice}`);
    record('TEST H: coinTossSelectionComplete + game launch', 'pass',
      `priority=${selResult.priorityChoice} nonPriority=${selResult.nonPriorityChoice}`);
    await client.sendChatMessage(MSG_LAUNCH_DONE);
    await sleep(2000);
  } catch (err) {
    fail('coinTossSelectionComplete', String(err));
    record('TEST H: coinTossSelectionComplete + game launch', 'fail', String(err));
    info('Players may not have made their selection in time — test recorded as failed.');
    await sleep(5000);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  section('DONE — leaving lobby');
  await client.sendChatMessage(`Testy zakończone! Dziękujemy ${TESTERS.map((t) => t.name).join(' i ')}. Opuszczam lobby za 5 sekund.`);
  await sleep(5000);

  await client.disconnect();
  printSummary();
}

// ─── Summary printer ─────────────────────────────────────────────────────────

function printSummary(): void {
  section('TEST SUMMARY');
  const passed  = results.filter((r) => r.status === 'pass').length;
  const failed  = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  for (const r of results) {
    const icon  = r.status === 'pass' ? '\x1b[32m✓\x1b[0m' : r.status === 'fail' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⊘\x1b[0m';
    const note  = r.note ? `  (${r.note})` : '';
    console.log(`  ${icon} ${r.step}${note}`);
  }

  console.log('');
  console.log(`  Passed : ${passed}`);
  console.log(`  Failed : ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log('');

  if (failed > 0) {
    console.log('\x1b[31m  RESULT: FAIL\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m  RESULT: PASS\x1b[0m');
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
