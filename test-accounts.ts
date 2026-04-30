/**
 * Bot Account Registry Viewer
 *
 * Connects to Firestore and prints all registered bot accounts.
 * Passwords are never shown — just status, Steam IDs, and assignment info.
 *
 * Useful for:
 *   - Verifying which bots are registered in the admin panel
 *   - Checking their current status (idle / in_lobby / error)
 *   - Getting their Firestore document IDs (needed for --bot-id= when running worker)
 *   - Confirming steamId32 values for test file constants
 *
 * Usage:
 *   npx tsx bot-worker/test-accounts.ts
 *
 * Requires:
 *   FIREBASE_SERVICE_ACCOUNT_BASE64 in bot-worker/.env
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ─── Firebase init ─────────────────────────────────────────────────────────

function initFirebase() {
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set in .env');
    process.exit(1);
  }
  const sa = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  const existing = getApps().find((a) => a.name === 'test-accounts');
  const app = existing || initializeApp({ credential: cert(sa) }, 'test-accounts');
  return getFirestore(app);
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface BotAccountDoc {
  username: string;
  displayName: string;
  steamId: string;
  steamId32: string;
  enabled: boolean;
  status: string;
  currentMatchId: string | null;
  currentTournamentId: string | null;
  lastHeartbeat: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  idle: '\x1b[32m',        // green
  in_lobby: '\x1b[33m',   // yellow
  error: '\x1b[31m',      // red
  offline: '\x1b[90m',    // grey
};

function colorStatus(status: string): string {
  const c = STATUS_COLOR[status] ?? '\x1b[36m';
  return `${c}${status}\x1b[0m`;
}

function formatHeartbeat(iso: string | null): string {
  if (!iso) return '\x1b[90mnever\x1b[0m';
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function padRight(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const bare = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - bare.length));
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\x1b[1m\nPD2IH — Registered Bot Accounts\x1b[0m');
  console.log(`Fetched: ${new Date().toLocaleString('pl-PL')}\n`);

  const db = initFirebase();

  const snapshot = await db.collection('botAccounts').orderBy('createdAt').get();

  if (snapshot.empty) {
    console.log('  \x1b[33mNo bot accounts registered yet.\x1b[0m');
    console.log('  → Add accounts via the admin panel: /{tournament}/admin → Bot tab → Konta Steam\n');
    process.exit(0);
  }

  // Header row
  console.log(
    '\x1b[1m' +
    padRight('  #', 4) +
    padRight('Doc ID', 24) +
    padRight('Username', 16) +
    padRight('Display name', 20) +
    padRight('Steam32', 12) +
    padRight('Status', 16) +
    padRight('Enabled', 9) +
    padRight('Heartbeat', 12) +
    'Notes' +
    '\x1b[0m'
  );
  console.log('  ' + '─'.repeat(120));

  snapshot.docs.forEach((doc, i) => {
    const d = doc.data() as BotAccountDoc;
    const row = [
      padRight(`  ${i + 1}`, 4),
      padRight(doc.id, 24),
      padRight(d.username, 16),
      padRight(d.displayName, 20),
      padRight(d.steamId32 || '—', 12),
      padRight(colorStatus(d.status), 16),
      padRight(d.enabled ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m', 9),
      padRight(formatHeartbeat(d.lastHeartbeat), 12),
      d.notes ?? '',
    ].join('');
    console.log(row);
  });

  console.log('\n  Total: ' + snapshot.size + ' account(s)\n');

  // Show assignment details if any bot is active
  const activeBots = snapshot.docs.filter((d) => {
    const data = d.data() as BotAccountDoc;
    return data.currentMatchId !== null || data.currentTournamentId !== null;
  });

  if (activeBots.length > 0) {
    console.log('\x1b[1m  Active assignments:\x1b[0m');
    for (const doc of activeBots) {
      const d = doc.data() as BotAccountDoc;
      console.log(`    [${d.username}] → match: ${d.currentMatchId ?? '—'}  tournament: ${d.currentTournamentId ?? '—'}`);
    }
    console.log('');
  }

  // Print how to run each bot
  console.log('\x1b[1m  How to start each bot worker:\x1b[0m');
  for (const doc of snapshot.docs) {
    const d = doc.data() as BotAccountDoc;
    const cred = `STEAM_USERNAME=${d.username} STEAM_PASSWORD=<password>`;
    console.log(`    # ${d.displayName}`);
    console.log(`    ${cred} npx tsx bot-worker/src/index.ts --bot-id=${doc.id}`);
  }
  console.log('');

  // Print Steam32 map — useful for test constants
  console.log('\x1b[1m  Steam identity map (copy into test files):\x1b[0m');
  snapshot.docs.forEach((doc, i) => {
    const d = doc.data() as BotAccountDoc;
    console.log(`    Bot ${i + 1}: steam32=${d.steamId32 || '?'}  steam64=${d.steamId || '?'}  username=${d.username}`);
  });
  console.log('');
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
