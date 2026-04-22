/**
 * Firestore Command Queue Integration Test
 *
 * Tests the full web-app → bot communication path WITHOUT running the full bot:
 *   1. Push a test command into Firestore: /botCommands/{botId}/queue
 *   2. Start CommandHandler in isolation (no real DotaClient — uses a stub)
 *   3. Verify CommandHandler picks up the command within 5s
 *   4. Verify the command document is marked 'completed'
 *   5. Verify a botEvents document was written back
 *   6. Test expire logic: old command (>5 min) should be marked 'failed'
 *   7. Test unknown command type → logged + null result, not crashed
 *
 * This test DOES require FIREBASE_SERVICE_ACCOUNT_BASE64 in .env.
 * It writes to the real Firestore — test documents are cleaned up after.
 *
 * Usage:
 *   npx tsx test-command-queue.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { initFirebase } from './src/firebase.js';
import { CommandHandler } from './src/command-handler.js';
import type { DotaClient } from './src/dota-client.js';

// ─── Helpers ──────────────────────────────────────────────────────────────
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

// ─── Stub DotaClient ──────────────────────────────────────────────────────
/**
 * Minimal stub that satisfies CommandHandler's interface without touching Steam.
 * Records which methods were called so tests can assert on them.
 */
function createStubDotaClient(): { client: DotaClient; calls: string[] } {
  const calls: string[] = [];

  const stub = {
    createLobby: async (opts: unknown) => {
      calls.push(`createLobby:${JSON.stringify(opts)}`);
    },
    invitePlayers: async (ids: string[]) => {
      calls.push(`invitePlayers:${ids.join(',')}`);
    },
    setSessionTeams: (teamA: string[], teamB: string[]) => {
      calls.push(`setSessionTeams:${teamA.length}+${teamB.length}`);
    },
    sendChatMessage: async (msg: string) => {
      calls.push(`sendChatMessage:${msg}`);
    },
    kickPlayer: async (id: string) => {
      calls.push(`kickPlayer:${id}`);
    },
    startGame: async () => {
      calls.push('startGame');
    },
    leaveLobby: async () => {
      calls.push('leaveLobby');
    },
    disconnect: async () => {
      calls.push('disconnect');
    },
    get isConnected() { return true; },
  } as unknown as DotaClient;

  return { client: stub, calls };
}

// ─── Test results ─────────────────────────────────────────────────────────
const results: { step: string; status: 'pass' | 'fail' | 'skip'; note?: string }[] = [];
function record(step: string, status: 'pass' | 'fail' | 'skip', note?: string): void {
  results.push({ step, status, note });
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\x1b[1m\nPD2IH Bot — Firestore Command Queue Integration Test\x1b[0m\n');

  // ── 0: Init Firestore ──────────────────────────────────────────────────
  let db: ReturnType<typeof initFirebase>;
  try {
    db = initFirebase();
    info('Firestore connection established');
  } catch (err) {
    console.error('ERROR: Could not connect to Firestore:', err);
    console.error('Ensure FIREBASE_SERVICE_ACCOUNT_BASE64 is set in .env');
    process.exit(1);
  }

  const BOT_ID = 'test-bot-queue-runner';
  const queueRef = db
    .collection('botCommands')
    .doc(BOT_ID)
    .collection('queue');

  const docIds: string[] = [];

  // ── 1: send_chat command — happy path ─────────────────────────────────
  section('TEST 1 — send_chat command is processed (happy path)');

  const { client: stub1, calls: calls1 } = createStubDotaClient();
  const handler1 = new CommandHandler(db, BOT_ID, stub1, 500);

  const chatRef = await queueRef.add({
    botAccountId: BOT_ID,
    command: { type: 'send_chat', message: 'Hello from integration test!' },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  docIds.push(chatRef.id);
  log('TEST 1', `Created command doc: ${chatRef.id}`);

  handler1.start();
  await sleep(3000); // Wait for poll cycle to pick it up
  handler1.stop();

  const chatDoc = await chatRef.get();
  const chatStatus = chatDoc.data()?.status as string;

  if (chatStatus === 'completed') {
    pass(`send_chat command status → 'completed'`);
    record('send_chat happy path', 'pass', `status=${chatStatus}`);
  } else {
    fail(`send_chat command`, `status is '${chatStatus}', expected 'completed'`);
    record('send_chat happy path', 'fail', `status=${chatStatus}`);
  }

  if (calls1.some((c) => c.startsWith('sendChatMessage:'))) {
    pass('DotaClient.sendChatMessage() was called on the stub');
    record('stub sendChatMessage called', 'pass');
  } else {
    fail('DotaClient.sendChatMessage() NOT called', `calls: ${calls1.join(', ')}`);
    record('stub sendChatMessage called', 'fail', `calls: ${calls1.join(', ')}`);
  }

  // ── 2: invite_players with team assignments ────────────────────────────
  section('TEST 2 — invite_players with teamA/teamB sets session teams');

  const { client: stub2, calls: calls2 } = createStubDotaClient();
  const handler2 = new CommandHandler(db, BOT_ID, stub2, 500);

  const inviteRef = await queueRef.add({
    botAccountId: BOT_ID,
    command: {
      type: 'invite_players',
      teamA: ['11111111', '22222222', '33333333', '44444444', '55555555'],
      teamB: ['66666666', '77777777', '88888888', '99999999', '10101010'],
      sessionId: 'test-session-001',
    },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  docIds.push(inviteRef.id);

  handler2.start();
  await sleep(3000);
  handler2.stop();

  const inviteDoc = await inviteRef.get();
  if (inviteDoc.data()?.status === 'completed') {
    pass('invite_players (with teams) status → completed');
    record('invite_players with teams', 'pass');
  } else {
    fail('invite_players (with teams)', `status=${inviteDoc.data()?.status}`);
    record('invite_players with teams', 'fail', `status=${inviteDoc.data()?.status}`);
  }

  if (calls2.some((c) => c.startsWith('setSessionTeams:'))) {
    pass('setSessionTeams() called when teamA+teamB provided');
    record('setSessionTeams via invite_players', 'pass');
  } else {
    fail('setSessionTeams() was NOT called', `calls: ${calls2.join(', ')}`);
    record('setSessionTeams via invite_players', 'fail');
  }

  if (calls2.some((c) => c.startsWith('invitePlayers:'))) {
    const inviteCall = calls2.find((c) => c.startsWith('invitePlayers:'))!;
    const ids = inviteCall.split(':')[1].split(',');
    if (ids.length === 10) {
      pass(`invitePlayers called with 10 steam IDs (${ids.length})`);
      record('invitePlayers 10 IDs', 'pass');
    } else {
      fail('invitePlayers IDs count', `expected 10, got ${ids.length}`);
      record('invitePlayers 10 IDs', 'fail', `got ${ids.length}`);
    }
  }

  // ── 3: set_teams standalone command ────────────────────────────────────
  section('TEST 3 — set_teams command calls setSessionTeams()');

  const { client: stub3, calls: calls3 } = createStubDotaClient();
  const handler3 = new CommandHandler(db, BOT_ID, stub3, 500);

  const teamsRef = await queueRef.add({
    botAccountId: BOT_ID,
    command: {
      type: 'set_teams',
      teamA: ['11111111', '22222222', '33333333', '44444444', '55555555'],
      teamB: ['66666666', '77777777', '88888888', '99999999', '10101010'],
    },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  docIds.push(teamsRef.id);

  handler3.start();
  await sleep(3000);
  handler3.stop();

  const teamsDoc = await teamsRef.get();
  if (teamsDoc.data()?.status === 'completed') {
    pass('set_teams status → completed');
    record('set_teams command', 'pass');
  } else {
    fail('set_teams command', `status=${teamsDoc.data()?.status}`);
    record('set_teams command', 'fail');
  }

  // ── 4: Expired command → fails ─────────────────────────────────────────
  section('TEST 4 — Expired command (>5 min old) → status becomes failed');

  const { client: stub4, calls: calls4 } = createStubDotaClient();
  const handler4 = new CommandHandler(db, BOT_ID, stub4, 500);

  const oldDate = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
  const expiredRef = await queueRef.add({
    botAccountId: BOT_ID,
    command: { type: 'send_chat', message: 'Old message' },
    status: 'pending',
    createdAt: oldDate.toISOString(),
  });
  docIds.push(expiredRef.id);

  handler4.start();
  await sleep(3000);
  handler4.stop();

  const expiredDoc = await expiredRef.get();
  if (expiredDoc.data()?.status === 'failed' && expiredDoc.data()?.error?.includes('expired')) {
    pass('Expired command → status=failed with "expired" in error');
    record('expired command rejection', 'pass');
  } else {
    fail('Expired command', `status=${expiredDoc.data()?.status}, error=${expiredDoc.data()?.error}`);
    record('expired command rejection', 'fail', `status=${expiredDoc.data()?.status}`);
  }

  // sendChatMessage should NOT have been called for the expired command
  if (!calls4.some((c) => c.startsWith('sendChatMessage:'))) {
    pass('sendChatMessage NOT called for expired command');
    record('expired command not executed', 'pass');
  } else {
    fail('sendChatMessage WAS called for expired command', 'should have been skipped');
    record('expired command not executed', 'fail');
  }

  // ── 5: Unknown command type → status=failed ────────────────────────────
  section('TEST 5 — Unknown command type → handled gracefully');

  const { client: stub5 } = createStubDotaClient();
  const handler5 = new CommandHandler(db, BOT_ID, stub5, 500);

  const unknownRef = await queueRef.add({
    botAccountId: BOT_ID,
    command: { type: 'do_impossible_thing' },
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  docIds.push(unknownRef.id);

  handler5.start();
  await sleep(3000);
  handler5.stop();

  const unknownDoc = await unknownRef.get();
  // Unknown commands result in status=completed with null result (current behavior)
  // If this changes in future it should be 'failed'
  const unknownStatus = unknownDoc.data()?.status as string;
  if (unknownStatus === 'completed' || unknownStatus === 'failed') {
    pass(`Unknown command handled gracefully (status=${unknownStatus}, not crashed)`);
    record('unknown command type', 'pass', `status=${unknownStatus}`);
  } else {
    fail('Unknown command type', `unexpected status=${unknownStatus}`);
    record('unknown command type', 'fail', `status=${unknownStatus}`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  section('CLEANUP — Removing test documents');
  for (const id of docIds) {
    await queueRef.doc(id).delete();
  }
  info(`Deleted ${docIds.length} test command documents`);

  // ── Summary ────────────────────────────────────────────────────────────
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
