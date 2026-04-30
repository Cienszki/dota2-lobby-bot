/**
 * Pure-logic unit tests for bot message helpers.
 * No Steam connection, no Firestore — runs in < 1 second.
 *
 * Tests:
 *   1. applyPlaceholders — {player_name}, {team_name}, {missing}
 *   2. getEffectiveChatMessages — per-bot override merging
 *   3. Slot validation logic (mirrors handleChatForReadyCheck)
 *   4. Integration: slot rejection builds {missing} string correctly
 *
 * Usage:
 *   npx tsx bot-worker/test-placeholder-logic.ts
 */

// ── Inline implementations ─────────────────────────────────────────────────
// These are verbatim copies of the functions in src/lib/bot/bot-agent.ts.
// If the production code changes, update these copies.

function applyPlaceholders(
  message: string,
  ctx: { player_name?: string; team_name?: string; missing?: string }
): string {
  return message
    .replace(/\{player_name\}/g, ctx.player_name ?? '')
    .replace(/\{team_name\}/g, ctx.team_name ?? '')
    .replace(/\{missing\}/g, ctx.missing ?? '');
}

interface LobbyChatConfig {
  welcomeMessage: string;
  teamNotReadyMessage: string;
  teamReadyMessage: string;
  allReadyMessage: string;
  requirementsNotMetPrefix: string;
  rulesReminder?: string;
  matchStartMessage?: string;
  customCommands: unknown[];
}

interface TournamentBotConfig {
  chatMessages: LobbyChatConfig;
  perBotMessages?: Record<string, Partial<LobbyChatConfig>>;
}

function getEffectiveChatMessages(
  botConfig: TournamentBotConfig,
  botAccountId: string
): LobbyChatConfig {
  const overrides = botConfig.perBotMessages?.[botAccountId];
  if (!overrides) return botConfig.chatMessages;
  return { ...botConfig.chatMessages, ...overrides };
}

interface ExpectedPlayer { steamId32: string; nickname: string; }
interface CurrentPlayer  { steamId32: string; teamSide: 'radiant' | 'dire' | 'spectator' | 'unassigned'; }

/** Mirror of handleChatForReadyCheck slot validation block */
function checkTeamSlots(
  expectedPlayers: ExpectedPlayer[],
  team: 'radiant' | 'dire',
  currentPlayers: CurrentPlayer[]
): { valid: boolean; missingNames: string[] } {
  const playersOnCorrectSide = new Set(
    currentPlayers.filter((p) => p.teamSide === team).map((p) => p.steamId32)
  );
  const missing = expectedPlayers.filter((p) => !playersOnCorrectSide.has(p.steamId32));
  return {
    valid: missing.length === 0,
    missingNames: missing.map((p) => p.nickname),
  };
}

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, got?: unknown): void {
  if (condition) {
    console.log(`\x1b[32m  ✓ ${label}\x1b[0m`);
    passed++;
  } else {
    const detail = got !== undefined ? `  (got: ${JSON.stringify(got)})` : '';
    console.log(`\x1b[31m  ✗ ${label}${detail}\x1b[0m`);
    failed++;
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  ok(label, actual === expected, actual);
}

function deepEq(label: string, actual: unknown, expected: unknown): void {
  ok(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    actual
  );
}

function section(title: string): void {
  console.log(
    `\n\x1b[1m── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}\x1b[0m`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. applyPlaceholders
// ══════════════════════════════════════════════════════════════════════════════

section('1. applyPlaceholders');

eq(
  '{player_name} replaced',
  applyPlaceholders('Hello {player_name}!', { player_name: 'Cienszki' }),
  'Hello Cienszki!'
);

eq(
  '{team_name} replaced',
  applyPlaceholders('{team_name} jest gotowy!', { team_name: 'Chaos' }),
  'Chaos jest gotowy!'
);

eq(
  '{missing} replaced',
  applyPlaceholders('Brakuje: {missing}', { missing: 'Foo, Bar' }),
  'Brakuje: Foo, Bar'
);

eq(
  'all three placeholders in one string',
  applyPlaceholders('{player_name} ({team_name}): brakuje {missing}', {
    player_name: 'Cienszki',
    team_name: 'Chaos',
    missing: 'PlayerA, PlayerB',
  }),
  'Cienszki (Chaos): brakuje PlayerA, PlayerB'
);

eq(
  'placeholder repeated — both replaced',
  applyPlaceholders('{player_name} {player_name}', { player_name: 'X' }),
  'X X'
);

eq(
  'missing ctx key → empty string (not undefined literal)',
  applyPlaceholders('Hi {player_name}!', {}),
  'Hi !'
);

eq(
  'ctx key present but empty string → stays empty',
  applyPlaceholders('Hi {player_name}!', { player_name: '' }),
  'Hi !'
);

eq(
  'unknown placeholder left as-is',
  applyPlaceholders('Hello {unknown}!', { player_name: 'X' }),
  'Hello {unknown}!'
);

eq(
  'empty message → empty result',
  applyPlaceholders('', { player_name: 'X', team_name: 'Y', missing: 'Z' }),
  ''
);

eq(
  'no placeholders → message unchanged',
  applyPlaceholders('Good luck & have fun!', { player_name: 'X' }),
  'Good luck & have fun!'
);

eq(
  'multiline message with placeholder',
  applyPlaceholders('Cześć {player_name}!\nDobrego meczu!', { player_name: 'Cienszki' }),
  'Cześć Cienszki!\nDobrego meczu!'
);

// Real default template from DEFAULT_CHAT_CONFIG
eq(
  'full teamNotReadyMessage template substitution',
  applyPlaceholders(
    '{player_name}: Not all {team_name} players are in the correct slots yet. Missing: {missing}',
    { player_name: 'Cienszki', team_name: 'Chaos', missing: 'PlayerA' }
  ),
  'Cienszki: Not all Chaos players are in the correct slots yet. Missing: PlayerA'
);

// ══════════════════════════════════════════════════════════════════════════════
// 2. getEffectiveChatMessages
// ══════════════════════════════════════════════════════════════════════════════

section('2. getEffectiveChatMessages');

const BASE_CONFIG: TournamentBotConfig = {
  chatMessages: {
    welcomeMessage: 'Witaj w lobby!',
    teamNotReadyMessage: '{player_name}: brak graczy w slotach. Missing: {missing}',
    teamReadyMessage: '{team_name} gotowy!',
    allReadyMessage: 'Obie drużyny gotowe!',
    requirementsNotMetPrefix: 'Problem:',
    matchStartMessage: 'GL HF!',
    customCommands: [],
  },
};

{
  // No perBotMessages at all → returns base config untouched
  const result = getEffectiveChatMessages(BASE_CONFIG, 'bot1');
  eq('no perBotMessages → base welcomeMessage', result.welcomeMessage, 'Witaj w lobby!');
  eq('no perBotMessages → base teamReadyMessage', result.teamReadyMessage, '{team_name} gotowy!');
  eq('no perBotMessages → same object reference', result, BASE_CONFIG.chatMessages);
}

{
  // perBotMessages key present but for a DIFFERENT bot — should not affect bot1
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: { bot2: { welcomeMessage: 'CUSTOM!' } },
  };
  const result = getEffectiveChatMessages(cfg, 'bot1');
  eq('override for bot2 does not affect bot1', result.welcomeMessage, 'Witaj w lobby!');
}

{
  // Single field override for bot2
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: { bot2: { welcomeMessage: 'Siemanko {player_name}!' } },
  };
  const bot2 = getEffectiveChatMessages(cfg, 'bot2');
  eq('bot2 override → custom welcomeMessage', bot2.welcomeMessage, 'Siemanko {player_name}!');
  eq('bot2 override → base teamReadyMessage unchanged', bot2.teamReadyMessage, '{team_name} gotowy!');
  eq('bot2 override → base allReadyMessage unchanged', bot2.allReadyMessage, 'Obie drużyny gotowe!');
}

{
  // Multiple fields overridden for one bot
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: {
      botA: {
        welcomeMessage: 'Ahoy {player_name}!',
        allReadyMessage: 'LET\'S GOOOOO!!!',
      },
    },
  };
  const result = getEffectiveChatMessages(cfg, 'botA');
  eq('multi-override: welcomeMessage', result.welcomeMessage, 'Ahoy {player_name}!');
  eq('multi-override: allReadyMessage', result.allReadyMessage, "LET'S GOOOOO!!!");
  eq('multi-override: unaffected field', result.teamReadyMessage, '{team_name} gotowy!');
}

{
  // Override with empty object (no actual overrides) → should return merged object but identical values
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: { bot1: {} },
  };
  const result = getEffectiveChatMessages(cfg, 'bot1');
  eq('empty override object → base welcomeMessage', result.welcomeMessage, 'Witaj w lobby!');
  eq('empty override object → base allReadyMessage', result.allReadyMessage, 'Obie drużyny gotowe!');
}

{
  // Override a field with undefined (should not overwrite base field)
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: { bot1: { rulesReminder: undefined } },
  };
  const result = getEffectiveChatMessages(cfg, 'bot1');
  // Spread of { rulesReminder: undefined } onto base — undefined overrides the key but value is undefined
  // This is fine; undefined rulesReminder means "no rules reminder", same as base
  ok('undefined override field does not throw', typeof result.welcomeMessage === 'string');
}

{
  // Two different bots, both with overrides, don't cross-contaminate
  const cfg: TournamentBotConfig = {
    ...BASE_CONFIG,
    perBotMessages: {
      bot1: { welcomeMessage: 'Bot1 greeting' },
      bot2: { welcomeMessage: 'Bot2 greeting' },
    },
  };
  eq('bot1 greeting', getEffectiveChatMessages(cfg, 'bot1').welcomeMessage, 'Bot1 greeting');
  eq('bot2 greeting', getEffectiveChatMessages(cfg, 'bot2').welcomeMessage, 'Bot2 greeting');
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Slot validation (mirrors handleChatForReadyCheck logic)
// ══════════════════════════════════════════════════════════════════════════════

section('3. Slot validation (checkTeamSlots)');

const CIENSZKI: ExpectedPlayer = { steamId32: '35747920', nickname: 'Cienszki' };
const PLAYER_B: ExpectedPlayer  = { steamId32: '12345678', nickname: 'PlayerB'  };
const PLAYER_C: ExpectedPlayer  = { steamId32: '99999999', nickname: 'PlayerC'  };
const PLAYER_D: ExpectedPlayer  = { steamId32: '77777777', nickname: 'PlayerD'  };
const PLAYER_E: ExpectedPlayer  = { steamId32: '55555555', nickname: 'PlayerE'  };

// --- Happy paths ---

{
  const r = checkTeamSlots(
    [CIENSZKI],
    'radiant',
    [{ steamId32: '35747920', teamSide: 'radiant' }]
  );
  ok('solo player in correct slot → valid', r.valid);
  deepEq('solo player → no missing names', r.missingNames, []);
}

{
  const r = checkTeamSlots(
    [CIENSZKI, PLAYER_B],
    'radiant',
    [
      { steamId32: '35747920', teamSide: 'radiant' },
      { steamId32: '12345678', teamSide: 'radiant' },
    ]
  );
  ok('two players both on correct side → valid', r.valid);
  deepEq('two players → no missing', r.missingNames, []);
}

{
  // Full 5-player team
  const r = checkTeamSlots(
    [CIENSZKI, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E],
    'radiant',
    [CIENSZKI, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E].map((p) => ({
      steamId32: p.steamId32,
      teamSide: 'radiant' as const,
    }))
  );
  ok('full 5-player team on correct side → valid', r.valid);
  deepEq('full team → no missing', r.missingNames, []);
}

{
  // Team is on DIRE and we check DIRE → valid
  const r = checkTeamSlots(
    [CIENSZKI, PLAYER_B],
    'dire',
    [
      { steamId32: '35747920', teamSide: 'dire' },
      { steamId32: '12345678', teamSide: 'dire' },
    ]
  );
  ok('team on dire side, check dire → valid', r.valid);
}

// --- Failure paths ---

{
  // Player in UNASSIGNED — not on correct side
  const r = checkTeamSlots(
    [CIENSZKI],
    'radiant',
    [{ steamId32: '35747920', teamSide: 'unassigned' }]
  );
  ok('player in unassigned → invalid', !r.valid);
  deepEq('player in unassigned → name in missing list', r.missingNames, ['Cienszki']);
}

{
  // Player on WRONG team side (Dire instead of expected Radiant)
  const r = checkTeamSlots(
    [CIENSZKI],
    'radiant',
    [{ steamId32: '35747920', teamSide: 'dire' }]
  );
  ok('player on wrong side → invalid', !r.valid);
  deepEq('wrong side → name in list', r.missingNames, ['Cienszki']);
}

{
  // 1 of 2 in correct slot, 1 in unassigned
  const r = checkTeamSlots(
    [CIENSZKI, PLAYER_B],
    'radiant',
    [
      { steamId32: '35747920', teamSide: 'radiant' },
      { steamId32: '12345678', teamSide: 'unassigned' },
    ]
  );
  ok('1 missing, 1 present → invalid', !r.valid);
  deepEq('1 missing → correct name', r.missingNames, ['PlayerB']);
}

{
  // All missing (nobody in lobby)
  const r = checkTeamSlots([CIENSZKI, PLAYER_B, PLAYER_C], 'radiant', []);
  ok('no current players → invalid', !r.valid);
  eq('all 3 missing → 3 names', r.missingNames.length, 3);
}

{
  // Extra players on the correct side (uninvited people) — doesn't affect validation
  const r = checkTeamSlots(
    [CIENSZKI],
    'radiant',
    [
      { steamId32: '35747920', teamSide: 'radiant' },
      { steamId32: '00000001', teamSide: 'radiant' }, // uninvited
    ]
  );
  ok('extra uninvited player on side does not break validation', r.valid);
}

{
  // Cienszki is present on the correct side, but the CHECK is for a different team (dire)
  // → validation passes for dire (no dire players expected in this list)
  const r = checkTeamSlots(
    [],
    'dire',
    [{ steamId32: '35747920', teamSide: 'radiant' }]
  );
  ok('empty expected list for dire → valid (nothing to check)', r.valid);
  deepEq('empty expected → no missing', r.missingNames, []);
}

{
  // Spectator slot doesn't count as either team
  const r = checkTeamSlots(
    [CIENSZKI],
    'radiant',
    [{ steamId32: '35747920', teamSide: 'spectator' }]
  );
  ok('spectator slot → not counted as radiant → invalid', !r.valid);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Integration: full !r rejection message pipeline
// ══════════════════════════════════════════════════════════════════════════════

section('4. Integration — !r rejection builds correct response message');

{
  // Cienszki types !r while still in unassigned → should get teamNotReadyMessage
  const expected = [CIENSZKI, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E];
  const snapshot: CurrentPlayer[] = [
    { steamId32: '35747920', teamSide: 'unassigned' }, // Cienszki — not in slot
    { steamId32: '12345678', teamSide: 'radiant' },
    { steamId32: '99999999', teamSide: 'radiant' },
    { steamId32: '77777777', teamSide: 'radiant' },
    { steamId32: '55555555', teamSide: 'radiant' },
  ];

  const { valid, missingNames } = checkTeamSlots(expected, 'radiant', snapshot);
  ok('5-player team, 1 in unassigned → invalid', !valid);
  deepEq('only Cienszki missing', missingNames, ['Cienszki']);

  const botReply = applyPlaceholders(
    '{player_name}: Not all {team_name} players are in the correct slots yet. Missing: {missing}',
    { player_name: 'Cienszki', team_name: 'Chaos', missing: missingNames.join(', ') }
  );
  eq(
    'bot reply contains player name',
    botReply.includes('Cienszki'),
    true
  );
  eq(
    'bot reply contains team name',
    botReply.includes('Chaos'),
    true
  );
  eq(
    'bot reply contains missing player name',
    botReply.includes('Cienszki'),
    true
  );
}

{
  // All 5 present → teamReadyMessage should be sent
  const expected = [CIENSZKI, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E];
  const snapshot: CurrentPlayer[] = expected.map((p) => ({
    steamId32: p.steamId32,
    teamSide: 'radiant' as const,
  }));

  const { valid } = checkTeamSlots(expected, 'radiant', snapshot);
  ok('all 5 on correct side → valid, should send teamReadyMessage', valid);

  const botReply = applyPlaceholders(
    '{team_name} is ready! Waiting for the other team...',
    { team_name: 'Chaos' }
  );
  eq('teamReadyMessage substituted correctly', botReply, 'Chaos is ready! Waiting for the other team...');
}

{
  // 2 players missing from 5 → missing list should contain both names joined with ', '
  const expected = [CIENSZKI, PLAYER_B, PLAYER_C, PLAYER_D, PLAYER_E];
  const snapshot: CurrentPlayer[] = [
    { steamId32: '35747920', teamSide: 'radiant' },
    { steamId32: '12345678', teamSide: 'radiant' },
    { steamId32: '99999999', teamSide: 'unassigned' }, // missing
    { steamId32: '77777777', teamSide: 'unassigned' }, // missing
    { steamId32: '55555555', teamSide: 'radiant' },
  ];

  const { valid, missingNames } = checkTeamSlots(expected, 'radiant', snapshot);
  ok('2 missing → invalid', !valid);
  eq('2 missing → exactly 2 names', missingNames.length, 2);
  ok('missing list contains PlayerC', missingNames.includes('PlayerC'));
  ok('missing list contains PlayerD', missingNames.includes('PlayerD'));

  const joinedMissing = missingNames.join(', ');
  const botReply = applyPlaceholders(
    '{player_name}: missing {missing}', {
      player_name: 'Cienszki',
      missing: joinedMissing,
    }
  );
  ok('bot reply contains both missing names', botReply.includes('PlayerC') && botReply.includes('PlayerD'));
}

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(60));
console.log(`  Passed: \x1b[32m${passed}\x1b[0m   Failed: \x1b[31m${failed}\x1b[0m`);
if (failed > 0) {
  console.log('\x1b[31m\n  Some tests FAILED — fix before running live tests.\x1b[0m\n');
  process.exit(1);
} else {
  console.log('\x1b[32m\n  All logic tests passed ✓  Safe to run test-ready-check.ts\x1b[0m\n');
}
