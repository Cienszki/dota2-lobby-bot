// bot-worker/src/dota-client.ts
// Dota 2 client wrapper — manages Steam login and Dota 2 GC connection
//
// IMPORTANT: `dota2@7.0.3` (node-dota2) is built on top of the OLD `steam`
// npm package (not the modern `steam-user`). It internally does:
//   new steam.SteamUser(steamClient)
//   new steam.SteamGameCoordinator(steamClient, 570)
// So we MUST pass an old `steam.SteamClient` instance, not a `steam-user` instance.
//
// Key Dota2 GC APIs used:
// - Dota2.createPracticeLobby()  — create a custom lobby
// - Dota2.inviteToLobby()        — invite a player by Steam64 ID
// - Dota2.practiceLobbyKick()    — kick a player by Steam32 account ID
// - Dota2.launchPracticeLobby()  — start the game (coin toss)
// - Dota2.leavePracticeLobby()   — leave/destroy the lobby
// - Dota2.sendMessage()          — send a chat message in lobby
//
// Events emitted by Dota2:
// - 'practiceLobbyUpdate'  — lobby state changed (players join/leave/move)
// - 'practiceLobbyResponse'— response to lobby creation
// - 'chatMessage'          — someone sent a chat message
// - 'sourceTVGamesData'    — live game data (when spectating)

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Steam = require('steam');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Dota2 = require('dota2');
// node-dota2's _lobbyOptions whitelist does not include selection_priority_rules,
// so it gets silently dropped by _parseOptions. Patch it in so the field is forwarded
// to CMsgPracticeLobbySetDetails when creating/configuring a lobby.
Dota2._lobbyOptions.selection_priority_rules = 'number';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from './logger.js';

// Path for persisting the Steam sentry file
const SENTRY_PATH = path.join(process.cwd(), '.steam-sentry');

/** Lobby slot mapping */
const SLOT = {
  RADIANT_START: 0,
  RADIANT_END: 4,
  DIRE_START: 5,
  DIRE_END: 9,
  RADIANT_COACH: 10,
  DIRE_COACH: 11,
} as const;

export interface DotaClientConfig {
  username: string;
  password: string;
  /** @deprecated Steam Guard is disabled on bot accounts — kept for future use */
  steamGuardSharedSecret?: string;
}

export interface LobbyCreateOptions {
  name: string;
  password: string;
  gameMode: number;       // Dota2 game mode enum value
  serverRegion: number;   // Dota2 server region enum value
  visibility: number;     // 0=public, 1=friends, 2=unlisted
  dotaTvDelay: number;    // seconds
  seriesType: number;     // 0=none, 1=bo3, 2=bo5
  /** Current Radiant wins to show in series score UI (0 for game 1) */
  radiantSeriesWins?: number;
  /** Current Dire wins to show in series score UI (0 for game 1) */
  direSeriesWins?: number;
  leagueId?: number;
  cheatsEnabled: boolean;
  fillWithBots: boolean;
  allowSpectators: boolean;
  pauseSetting: number;   // 0=unlimited, 1=limited, 2=disabled
  /**
   * 0 = Manual (coin toss + player picks side/pick order)
   * 1 = Automatic (GC picks randomly, no player interaction) — default
   */
  selectionPriorityRules?: number;
}

export interface LobbyPlayerInfo {
  accountId: number;      // Steam32 account ID
  steamId32: string;      // String representation
  slot: number;
  team: 'radiant' | 'dire' | 'spectator' | 'unassigned';
  heroId?: number;
}

export interface LobbyChatMessage {
  accountId: number;
  steamId32: string;
  playerName: string;
  message: string;
}

/** Result of checking whether both teams have all 5 players seated on the same side */
export interface TeamSlotValidation {
  /** True when all 10 players are correctly seated: each team cohesively on one side */
  ready: boolean;
  /** Which side Team A is on ('radiant' | 'dire' | null if split or incomplete) */
  teamASide: 'radiant' | 'dire' | null;
  /** Which side Team B is on */
  teamBSide: 'radiant' | 'dire' | null;
  /** Number of Team A players currently in a player slot (Radiant or Dire) */
  teamAPresent: number;
  /** Number of Team B players currently in a player slot */
  teamBPresent: number;
  /** Steam32 IDs of Team A players not yet seated in any slot */
  teamAMissingIds: string[];
  /** Steam32 IDs of Team B players not yet seated in any slot */
  teamBMissingIds: string[];
  /** True when Team A players are split across both sides */
  teamASplit: boolean;
  /** True when Team B players are split across both sides */
  teamBSplit: boolean;
}

/**
 * Wraps Steam + Dota 2 client for lobby management.
 * Emits high-level events that map to BotEvent types.
 *
 * Uses the OLD `steam` npm package (a transitive dep of dota2@7.0.3) because
 * that is what dota2 expects. Modern `steam-user` is incompatible.
 */
export class DotaClient extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private steamClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private steamUser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private steamFriends: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dota2: any;
  private _connected = false;
  private _inDota = false;
  private _currentLobby: unknown = null;
  private _lobbyChannelName: string | null = null;
  // DOTAChatChannelType_t.DOTAChannelType_Lobby = 3 (confirmed from dota2 schema)
  private readonly LOBBY_CHAT_TYPE = 3;
  // Tracks Steam64 IDs of members already seen — used to detect new joiners
  private _knownMemberIds = new Set<string>();
  // Bot's own Steam32 ID — set after login to filter own events and skip auto-kick
  private _botSteam32: string | null = null;
  // Steam32 IDs of all players allowed in the lobby (empty = no restriction)
  private _allowedSteamId32s = new Set<string>();
  // Team assignments for slot validation
  private _teamA = new Set<string>();
  private _teamB = new Set<string>();
  // Coin toss (selection_priority_rules=0): tracks two-phase launch
  private _selectionPriorityRules = 0; // 0=Manual (GC proto default), 1=Automatic (Coin Toss)
  private _awaitingCoinTossSelection = false;
  private _coinTossResultEmitted = false;

  constructor(private config: DotaClientConfig) {
    super();
    this.steamClient  = new Steam.SteamClient();
    this.steamUser    = new Steam.SteamUser(this.steamClient);
    this.steamFriends = new Steam.SteamFriends(this.steamClient);
    this.dota2        = new Dota2.Dota2Client(this.steamClient, true, false);
    // Patch schema enums absent from our manually-built steam-resources
    if (!Dota2.schema.DOTAGameVersion) {
      Dota2.schema.DOTAGameVersion = { GAME_VERSION_STABLE: 0, GAME_VERSION_TEST: 1 };
    }
    this.setupEventHandlers();
  }

  get isConnected(): boolean {
    return this._connected && this._inDota;
  }

  // ─── Connection ─────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout (60s)'));
      }, 60000);

      const logOnDetails: Record<string, unknown> = {
        account_name: this.config.username,
        password: this.config.password,
      };

      // Load sentry file if present (avoids Steam Guard email on repeat logins)
      try {
        const sentry = fs.readFileSync(SENTRY_PATH);
        if (sentry.length) logOnDetails.sha_sentryfile = sentry;
      } catch { /* no sentry yet — first login */ }

      this.steamClient.connect();

      this.steamClient.on('connected', () => {
        logger.info('Steam: Connected to network');
        this.steamUser.logOn(logOnDetails);
      });

      this.steamClient.on('logOnResponse', (resp: { eresult: number }) => {
        if (resp.eresult === Steam.EResult.OK) {
          logger.info('Steam: Logged in successfully');
          this._connected = true;
          // Capture bot's own Steam32 to filter own events and skip auto-kick logic
          if (this.steamClient.steamID) {
            this._botSteam32 = String(this.steam64ToSteam32(this.steamClient.steamID));
            logger.debug(`Bot Steam32: ${this._botSteam32}`);
          }
          // Launch the Dota 2 GC connection
          this.dota2.launch();
        } else {
          clearTimeout(timeout);
          reject(new Error(`Steam login failed: EResult = ${resp.eresult}`));
        }
      });

      // Save sentry file to skip Steam Guard on future logins
      this.steamUser.on('updateMachineAuth', (
        sentry: { bytes: Buffer },
        callback: (arg: { sha_file: Buffer }) => void
      ) => {
        const hashed = crypto.createHash('sha1').update(sentry.bytes).digest();
        fs.writeFileSync(SENTRY_PATH, hashed);
        logger.debug('Steam: Sentry file saved');
        callback({ sha_file: hashed });
      });

      this.dota2.on('ready', () => {
        logger.info('Dota 2: GC connection established');
        this._inDota = true;
        clearTimeout(timeout);
        resolve();
      });

      this.steamClient.on('error', (err: Error) => {
        logger.error('Steam: Connection error', err);
        this._connected = false;
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this._currentLobby) {
      try {
        await this.leaveLobby();
      } catch {
        // Ignore errors when leaving lobby during disconnect
      }
    }
    this.dota2.exit();
    this.steamClient.disconnect();
    this._connected = false;
    this._inDota = false;
    logger.info('Disconnected from Steam/Dota 2');
  }

  // ─── Lobby Management ──────────────────────────────────────────────

  async createLobby(options: LobbyCreateOptions): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Lobby creation timeout (30s)'));
      }, 30000);

      const lobbyOptions: Record<string, unknown> = {
        game_name: options.name,
        pass_key: options.password,
        game_mode: options.gameMode,
        server_region: options.serverRegion,
        visibility: options.visibility,
        dota_tv_delay: this.dotaTvSecondsToEnum(options.dotaTvDelay),
        series_type: options.seriesType,
        allow_cheats: options.cheatsEnabled,
        fill_with_bots: options.fillWithBots,
        allow_spectating: options.allowSpectators,
        pause_setting: options.pauseSetting,
        // 0=Manual (no coin toss, START GAME) — single launchPracticeLobby() call.
        // 1=Automatic (coin toss, START PICK/SIDE SELECTION) — two-phase launch.
        selection_priority_rules: options.selectionPriorityRules ?? 1,
      };

      if (options.radiantSeriesWins !== undefined) {
        lobbyOptions.radiant_series_wins = options.radiantSeriesWins;
      }
      if (options.direSeriesWins !== undefined) {
        lobbyOptions.dire_series_wins = options.direSeriesWins;
      }

      if (options.leagueId) {
        lobbyOptions.leagueid = options.leagueId;
      }

      this.dota2.createPracticeLobby(
        lobbyOptions,
        (err: Error | null) => {
          clearTimeout(timeout);
          if (err) {
            logger.error('Failed to create lobby', err);
            reject(err);
          } else {
            // Join the lobby chat channel so sendChatMessage works
            const lobbyId = String(this.dota2.Lobby?.lobby_id ?? '');
            this._lobbyChannelName = `Lobby_${lobbyId}`;
            this.dota2.joinChat(this._lobbyChannelName, this.LOBBY_CHAT_TYPE);
            logger.info(`Lobby created — joined chat channel ${this._lobbyChannelName}`);
            // Store the selection priority rule so startGame() knows which phase logic to use
            this._selectionPriorityRules = options.selectionPriorityRules ?? 1;
            this._awaitingCoinTossSelection = false;
            this._coinTossResultEmitted = false;
            // Move bot out of Radiant slot 1 and into the unassigned player pool
            // so it doesn’t occupy a slot meant for human players.
            // joinPracticeLobbyTeam(slot, team): DOTA_GC_TEAM_PLAYER_POOL = 4
            this.dota2.joinPracticeLobbyTeam(1, 4);
            logger.info('Bot moved to unassigned player pool');
            // Give GC 1.5s to acknowledge chat join + team slot change before callers use them
            setTimeout(resolve, 1500);
          }
        }
      );
    });
  }

  /**
   * Configure which players are expected in this match lobby.
   * - Auto-kicks anyone who joins whose Steam32 is not in teamA or teamB.
   * - Enables slot validation in lobbyUpdate events.
   *
   * Call this before inviting players so the guard is active from the start.
   * Teams may be on either side (Radiant/Dire) — only cohesion per team matters.
   */
  setSessionTeams(teamA: string[], teamB: string[], whitelist: string[] = []): void {
    this._teamA = new Set(teamA);
    this._teamB = new Set(teamB);
    this._allowedSteamId32s = new Set([...teamA, ...teamB, ...whitelist]);
    logger.info(
      `Session teams set: TeamA(${teamA.length}) TeamB(${teamB.length}) Whitelist(${whitelist.length}) — ` +
      `auto-kick enabled for uninvited players`
    );
  }

  /** Clear session team data (call after lobby ends) */
  clearSessionTeams(): void {
    this._teamA.clear();
    this._teamB.clear();
    this._allowedSteamId32s.clear();
  }

  /**
   * Validate whether both teams have all 5 players seated on a single side.
   * Returns null when no teams have been configured via setSessionTeams().
   *
   * Rules:
   * - Team A's 5 players must ALL be on Radiant (slots 0-4) or ALL on Dire (slots 5-9)
   * - Team B's 5 players must all be on the OTHER side
   * - The specific side each team occupies doesn't matter
   * - Within a side, slot order doesn't matter
   */
  validateTeamSlots(): TeamSlotValidation | null {
    if (this._teamA.size === 0) return null;

    const lobby = this._currentLobby as Record<string, unknown> | null;
    if (!lobby) return null;

    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;

    const seatedRadiant = new Set<string>();
    const seatedDire    = new Set<string>();

    for (const m of members) {
      const accountId = this.steam64ToSteam32(m.id);
      const steam32   = String(accountId);
      // Skip bot itself and invalid entries
      if (accountId <= 0 || steam32 === this._botSteam32) continue;

      const teamNum   = Number(m.team ?? -1);
      const gcTeam    = this.gcTeamToString(teamNum);
      if (gcTeam === 'radiant') {
        seatedRadiant.add(steam32);
      } else if (gcTeam === 'dire') {
        seatedDire.add(steam32);
      }
    }

    const teamAOnRadiant = [...this._teamA].filter((id) => seatedRadiant.has(id)).length;
    const teamAOnDire    = [...this._teamA].filter((id) => seatedDire.has(id)).length;
    const teamBOnRadiant = [...this._teamB].filter((id) => seatedRadiant.has(id)).length;
    const teamBOnDire    = [...this._teamB].filter((id) => seatedDire.has(id)).length;

    // Scenario 1: Team A → Radiant, Team B → Dire
    const scenario1 =
      teamAOnRadiant === 5 && teamAOnDire === 0 &&
      teamBOnDire    === 5 && teamBOnRadiant === 0;
    // Scenario 2: Team A → Dire, Team B → Radiant
    const scenario2 =
      teamAOnDire    === 5 && teamAOnRadiant === 0 &&
      teamBOnRadiant === 5 && teamBOnDire    === 0;

    const ready = scenario1 || scenario2;

    const teamASide: 'radiant' | 'dire' | null =
      scenario1 ? 'radiant' : scenario2 ? 'dire' : null;
    const teamBSide: 'radiant' | 'dire' | null =
      scenario1 ? 'dire' : scenario2 ? 'radiant' : null;

    const seatedBoth    = new Set([...seatedRadiant, ...seatedDire]);
    const teamAMissingIds = [...this._teamA].filter((id) => !seatedBoth.has(id));
    const teamBMissingIds = [...this._teamB].filter((id) => !seatedBoth.has(id));

    // A team is "split" if its players are distributed across both sides
    const teamASplit = teamAOnRadiant > 0 && teamAOnDire > 0;
    const teamBSplit = teamBOnRadiant > 0 && teamBOnDire > 0;

    return {
      ready,
      teamASide,
      teamBSide,
      teamAPresent: teamAOnRadiant + teamAOnDire,
      teamBPresent: teamBOnRadiant + teamBOnDire,
      teamAMissingIds,
      teamBMissingIds,
      teamASplit,
      teamBSplit,
    };
  }

  async invitePlayer(steamId32: string): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');

    const accountId = parseInt(steamId32, 10);
    const steamId64 = this.steam32ToSteam64(accountId);

    // GC invite — shows as a bell notification inside Dota 2
    this.dota2.inviteToLobby(steamId64);

    // Steam friend message — appears as a chat notification even if Dota 2 is minimised
    // or the player dismissed the GC bell. The steam://joinlobby deep link opens Dota 2
    // and shows a join dialog when clicked.
    const lobbyId = this.dota2.Lobby?.lobby_id ? String(this.dota2.Lobby.lobby_id) : null;
    if (lobbyId) {
      const joinUrl = `steam://joinlobby/570/${lobbyId}`;
      const friendMsg = `You have been invited to a PD2IH lobby. Click to join: ${joinUrl}`;
      this.steamFriends.sendMessage(
        steamId64,
        friendMsg,
        Steam.EChatEntryType.ChatMsg
      );
      logger.debug(`Sent Steam friend join link to ${steamId32}: ${joinUrl}`);
    } else {
      logger.warn(`invitePlayer: lobby ID not available yet — Steam friend message skipped for ${steamId32}`);
    }

    logger.debug(`Invited player ${steamId32} (${steamId64})`);
  }

  async invitePlayers(steamId32s: string[]): Promise<void> {
    for (const id of steamId32s) {
      await this.invitePlayer(id);
      // Small delay between invites to avoid rate limiting
      await this.sleep(500);
    }
  }

  async sendChatMessage(message: string): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');
    if (!this._lobbyChannelName) {
      logger.warn('sendChatMessage called without an active lobby chat channel');
      return;
    }
    this.dota2.sendMessage(message, this._lobbyChannelName, this.LOBBY_CHAT_TYPE);
    logger.debug(`Chat [${this._lobbyChannelName}]: ${message}`);
  }

  async kickPlayer(steamId32: string): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');
    const accountId = parseInt(steamId32, 10);
    this.dota2.practiceLobbyKick(accountId);
    logger.debug(`Kicked player ${steamId32}`);
  }

  async startGame(): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');

    if (this._selectionPriorityRules === 1) {
      // Coin toss mode (Automatic): this is Phase 1 — triggers the coin toss UI for players.
      // Phase 2 (second launchPracticeLobby) fires automatically once the lobby
      // update shows both teams have made their selection (see practiceLobbyUpdate handler).
      this._awaitingCoinTossSelection = true;
      this._coinTossResultEmitted = false;
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._awaitingCoinTossSelection = false;
        reject(new Error('Game start timeout (30s)'));
      }, 30000);

      this.dota2.launchPracticeLobby((err: Error | null) => {
        clearTimeout(timeout);
        if (err) {
          this._awaitingCoinTossSelection = false;
          logger.error('Failed to start game', err);
          reject(err);
        } else {
          if (this._selectionPriorityRules === 1) {
            logger.info('Coin toss triggered — waiting for player side/pick selections before launching');
          } else {
            logger.info('Game launch initiated (Manual selection priority)');
          }
          resolve();
        }
      });
    });
  }

  async leaveLobby(): Promise<void> {
    if (!this.isConnected) return;

    return new Promise<void>((resolve) => {
      this.dota2.leavePracticeLobby((err: Error | null) => {
        if (err) {
          logger.warn('Error leaving lobby (non-fatal)', err);
        }
        this._currentLobby = null;
        this._lobbyChannelName = null;
        this._knownMemberIds.clear();
        this.clearSessionTeams();
        this._awaitingCoinTossSelection = false;
        this._coinTossResultEmitted = false;
        resolve();
      });
    });
  }

  /**
   * Get the current lobby state (players, teams, etc.)
   */
  getCurrentLobbyPlayers(): LobbyPlayerInfo[] {
    if (!this._currentLobby) return [];

    const lobby = this._currentLobby as Record<string, unknown>;
    const members = (lobby.all_members || lobby.members || []) as Array<Record<string, unknown>>;

    return members.map((member) => {
      // member.id is a Steam64 Long (the GC sends Steam64 IDs in CSODOTALobbyMember)
      const accountId = this.steam64ToSteam32(member.id);
      const steamId32 = accountId > 0 ? String(accountId) : '0';
      // member.slot is per-team (0-4 within that side), NOT the global 0-9 seat.
      // member.team is the DOTA_GC_TEAM enum: 0=Radiant, 1=Dire, 2=Broadcaster,
      // 3=Spectator, 4=PlayerPool (unassigned). Use it directly.
      const slot    = Number(member.slot ?? -1);
      const teamNum = Number(member.team ?? -1);
      const team    = this.gcTeamToString(teamNum);

      return {
        accountId,
        steamId32,
        slot,
        team,
        heroId: member.hero_id ? Number(member.hero_id) : undefined,
      };
    });
  }

  /**
   * Get team names from current lobby.
   * The GC sends team info in lobby.team_details[] — an array of up to 2 entries.
   * Index 0 = Radiant, index 1 = Dire. team_name is null when no team is selected.
   */
  getLobbyTeamNames(): { radiant: string; dire: string } {
    if (!this._currentLobby) return { radiant: '', dire: '' };
    const lobby = this._currentLobby as Record<string, unknown>;
    const details = lobby.team_details as Array<Record<string, unknown>> | undefined;
    const radiant = details?.[0]?.team_name ? String(details[0].team_name) : '';
    const dire    = details?.[1]?.team_name ? String(details[1].team_name) : '';
    return { radiant, dire };
  }

  /**
   * Returns the raw lobby object for debugging.
   * Use this to discover actual GC field names.
   */
  getRawLobby(): Record<string, unknown> | null {
    return this._currentLobby as Record<string, unknown> | null;
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Lobby state updates
    this.dota2.on('practiceLobbyUpdate', (lobby: unknown) => {
      this._currentLobby = lobby;

      // Detect new joiners: compare current members against previously-seen set.
      const lobbyData = lobby as Record<string, unknown>;
      const members = (lobbyData.all_members || lobbyData.members || []) as Array<Record<string, unknown>>;
      for (const m of members) {
        const steam64   = String(m.id);
        const accountId = this.steam64ToSteam32(m.id);
        const steam32   = String(accountId);

        if (!this._knownMemberIds.has(steam64)) {
          this._knownMemberIds.add(steam64);

          if (accountId > 0) {
            // Auto-kick uninvited players when a session is active.
            // Skip the bot itself (it's always the host and not in the invite list).
            if (
              this._allowedSteamId32s.size > 0 &&
              steam32 !== this._botSteam32 &&
              !this._allowedSteamId32s.has(steam32)
            ) {
              logger.warn(
                `Auto-kicking uninvited player: Steam32=${steam32} Steam64=${steam64}`
              );
              this.dota2.practiceLobbyKick(accountId);
              this.emit('playerKicked', { accountId, steamId64: steam64, reason: 'uninvited' });
            } else {
              logger.info(`Player joined lobby: Steam64=${steam64} accountId=${accountId}`);
              // Delay emit slightly so the player's client has time to join
              // the lobby chat channel before the caller sends a welcome message.
              // (The GC lobby join fires ~1-2s before the chat channel join.)
              setTimeout(() => {
                this.emit('playerJoined', { accountId, steamId64: steam64 });
              }, 2000);
            }
          }
        }
      }

      const players    = this.getCurrentLobbyPlayers();
      const teamNames  = this.getLobbyTeamNames();
      const slotValidation = this.validateTeamSlots();

      this.emit('lobbyUpdate', {
        players,
        radiantTeamName: teamNames.radiant,
        direTeamName: teamNames.dire,
        slotValidation,
      });

      // ─── Coin toss phase detection ─────────────────────────────────
      // Only active when selectionPriorityRules=1 (Coin Toss) and startGame() was called.
      if (this._awaitingCoinTossSelection) {
        const priorityTeamId = lobbyData.series_current_selection_priority_team_id;
        const priorityChoice    = Number(lobbyData.series_current_priority_team_choice    ?? 0);
        const nonPriorityChoice = Number(lobbyData.series_current_non_priority_team_choice ?? 0);

        // One-shot: emit the coin toss winner once priority team ID is set.
        // Guard against Long(0) — protobuf returns a truthy Long object even when
        // the field is 0 (no actual team ID assigned yet, e.g. without a leagueid).
        const priorityTeamIdNum = Number(priorityTeamId ?? 0);
        if (!this._coinTossResultEmitted && priorityTeamIdNum !== 0) {
          this._coinTossResultEmitted = true;
          const priorityTeamId32 = this.steam64ToSteam32(priorityTeamId);
          logger.info(`Coin toss result: priority team steam32=${priorityTeamId32}`);
          this.emit('coinTossResult', { priorityTeamId: String(priorityTeamId), priorityTeamId32 });
        }

        // Both teams chose → trigger Phase 2 (actual game launch)
        if (priorityChoice > 0 && nonPriorityChoice > 0) {
          this._awaitingCoinTossSelection = false;
          logger.info(`Coin toss selections complete (priority=${priorityChoice} non-priority=${nonPriorityChoice}) — launching game`);
          this.emit('coinTossSelectionComplete', { priorityChoice, nonPriorityChoice });
          this.dota2.launchPracticeLobby((err: Error | null) => {
            if (err) {
              logger.error('Failed to launch game after coin toss selection', err);
            } else {
              logger.info('Game launched after coin toss selection');
            }
          });
        }
      }
      // ──────────────────────────────────────────────────────────────
    });

    // Chat messages in lobby
    this.dota2.on('chatMessage', (
      _channel: string,
      senderName: string,
      message: string,
      chatData: Record<string, unknown>
    ) => {
      const accountId = Number(chatData.account_id || 0);
      // Skip messages sent by the bot itself to prevent accidental command loops.
      if (this._botSteam32 && String(accountId) === this._botSteam32) {
        logger.debug(`Ignoring own chat message: "${message}"`);
        return;
      }
      this.emit('chatMessage', {
        accountId,
        steamId32: String(accountId),
        playerName: senderName,
        message,
      } satisfies LobbyChatMessage);
    });

    // Game state changes (for detecting game start/end)
    this.dota2.on('sourceTVGamesData', (data: unknown) => {
      this.emit('sourceTVData', data);
    });

    // Handle being kicked or lobby destroyed
    this.dota2.on('practiceLobbyCleared', () => {
      logger.info('Lobby was cleared/destroyed');
      this._currentLobby = null;
      this._knownMemberIds.clear();
      this.clearSessionTeams();
      this._awaitingCoinTossSelection = false;
      this._coinTossResultEmitted = false;
      this.emit('lobbyCleared');
    });

    // Steam disconnection (old steam package uses 'error' for disconnect too)
    this.steamClient.on('error', (err: Error) => {
      logger.warn(`Steam disconnected/error: ${err?.message ?? err}`);
      this._connected = false;
      this._inDota = false;
      this.emit('disconnected', String(err?.message ?? err));
    });
  }

  private gcTeamToString(
    teamNum: number
  ): 'radiant' | 'dire' | 'spectator' | 'unassigned' {
    // DOTA_GC_TEAM: 0=GoodGuys(Radiant), 1=BadGuys(Dire),
    //               2=Broadcaster, 3=Spectator, 4=PlayerPool(unassigned)
    if (teamNum === 0) return 'radiant';
    if (teamNum === 1) return 'dire';
    if (teamNum === 2 || teamNum === 3) return 'spectator';
    return 'unassigned';
  }

  private slotToTeam(
    slot: number
  ): 'radiant' | 'dire' | 'spectator' | 'unassigned' {
    if (slot >= SLOT.RADIANT_START && slot <= SLOT.RADIANT_END) return 'radiant';
    if (slot >= SLOT.DIRE_START && slot <= SLOT.DIRE_END) return 'dire';
    if (slot === SLOT.RADIANT_COACH || slot === SLOT.DIRE_COACH) {
      return slot === SLOT.RADIANT_COACH ? 'radiant' : 'dire';
    }
    if (slot >= 12) return 'spectator';
    return 'unassigned';
  }

  private steam64ToSteam32(idLong: unknown): number {
    try {
      const steam64 = BigInt(String(idLong));
      const steam32 = steam64 - 76561197960265728n;
      return steam32 > 0n ? Number(steam32) : 0;
    } catch {
      return 0;
    }
  }

  private steam32ToSteam64(accountId: number): string {
    // Steam64 = accountId + 76561197960265728
    const base = BigInt('76561197960265728');
    return String(base + BigInt(accountId));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Maps a DotaTV delay in seconds to the LobbyDotaTVDelay enum value.
   * LobbyDotaTV_10=0, LobbyDotaTV_120=1, LobbyDotaTV_300=2, LobbyDotaTV_900=3
   */
  private dotaTvSecondsToEnum(seconds: number): number {
    if (seconds <= 10)  return 0; // LobbyDotaTV_10
    if (seconds <= 120) return 1; // LobbyDotaTV_120
    if (seconds <= 300) return 2; // LobbyDotaTV_300
    return 3;                     // LobbyDotaTV_900
  }
}
