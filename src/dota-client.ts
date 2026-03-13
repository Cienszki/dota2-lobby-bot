// bot-worker/src/dota-client.ts
// Dota 2 client wrapper — manages Steam login and Dota 2 GC connection
//
// This module wraps `steam-user` and `dota2` (node-dota2) to provide
// a clean interface for lobby management.
//
// NOTE: The `dota2` npm package provides protobuf-based communication
// with Valve's Game Coordinator (GC). Key APIs used:
// - Dota2.createPracticeLobby()  — create a custom lobby
// - Dota2.inviteToLobby()        — invite a player by Steam ID
// - Dota2.practiceLobbyKick()    — kick a player
// - Dota2.launchPracticeLobby()  — start the game (coin toss)
// - Dota2.leavePracticeLobby()   — leave/destroy the lobby
// - Dota2.sendMessage()          — send a chat message in lobby
//
// Events emitted by Dota2:
// - 'practiceLobbyUpdate'  — lobby state changed (players join/leave/move)
// - 'practiceLobbyResponse'— response to lobby creation
// - 'chatMessage'          — someone sent a chat message
// - 'sourceTVGamesData'    — live game data (when spectating)

import SteamUser from 'steam-user';
import * as Dota2 from 'dota2';
import { EventEmitter } from 'events';
import { logger } from './logger.js';

// Dota 2 GC enums (from node-dota2)
const {
  EServerRegion,
  DOTA_GameMode,
  DOTALobbyVisibility,
  schema,
} = Dota2;

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
  leagueId?: number;
  cheatsEnabled: boolean;
  fillWithBots: boolean;
  allowSpectators: boolean;
  pauseSetting: number;   // 0=unlimited, 1=limited, 2=disabled
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

/**
 * Wraps Steam + Dota 2 client for lobby management.
 * Emits high-level events that map to BotEvent types.
 */
export class DotaClient extends EventEmitter {
  private steam: SteamUser;
  private dota2: InstanceType<typeof Dota2.Dota2Client>;
  private _connected = false;
  private _inDota = false;
  private _currentLobby: unknown = null;

  constructor(private config: DotaClientConfig) {
    super();
    this.steam = new SteamUser();
    this.dota2 = new Dota2.Dota2Client(this.steam, true, true);
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

      this.steam.logOn({
        accountName: this.config.username,
        password: this.config.password,
        ...(this.config.steamGuardSharedSecret
          ? { twoFactorCode: this.config.steamGuardSharedSecret }
          : {}),
      });

      this.steam.on('loggedOn', () => {
        logger.info('Steam: Logged in successfully');
        this._connected = true;
        // Set status to Online and launch Dota 2
        this.steam.setPersona(SteamUser.EPersonaState.Online);
        this.steam.gamesPlayed([570]); // Dota 2 App ID
      });

      this.dota2.on('ready', () => {
        logger.info('Dota 2: GC connection established');
        this._inDota = true;
        clearTimeout(timeout);
        resolve();
      });

      this.steam.on('error', (err: Error) => {
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
    this.steam.logOff();
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
        dota_tv_delay: Math.floor(options.dotaTvDelay / 30), // Convert seconds to Dota TV delay enum
        series_type: options.seriesType,
        allow_cheats: options.cheatsEnabled,
        fill_with_bots: options.fillWithBots,
        allow_spectating: options.allowSpectators,
        pause_setting: options.pauseSetting,
      };

      if (options.leagueId) {
        lobbyOptions.leagueid = options.leagueId;
      }

      this.dota2.createPracticeLobby(
        lobbyOptions,
        (err: Error | null, body: unknown) => {
          clearTimeout(timeout);
          if (err) {
            logger.error('Failed to create lobby', err);
            reject(err);
          } else {
            logger.info('Lobby created successfully');
            resolve();
          }
        }
      );
    });
  }

  async invitePlayer(steamId32: string): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');

    // Convert Steam32 ID to Steam64 for the invite
    const accountId = parseInt(steamId32, 10);
    const steamId64 = this.steam32ToSteam64(accountId);

    this.dota2.inviteToLobby(steamId64);
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
    this.dota2.sendMessage(message, /* channel */ undefined, /* channel_type */ 1);
    logger.debug(`Chat: ${message}`);
  }

  async kickPlayer(steamId32: string): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');
    const accountId = parseInt(steamId32, 10);
    this.dota2.practiceLobbyKick(accountId);
    logger.debug(`Kicked player ${steamId32}`);
  }

  async startGame(): Promise<void> {
    if (!this.isConnected) throw new Error('Not connected to Dota 2 GC');

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Game start timeout (30s)'));
      }, 30000);

      this.dota2.launchPracticeLobby((err: Error | null) => {
        clearTimeout(timeout);
        if (err) {
          logger.error('Failed to start game', err);
          reject(err);
        } else {
          logger.info('Game launch initiated (coin toss)');
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
      const accountId = Number(member.id || member.account_id || 0);
      const slot = Number(member.slot ?? member.team_slot ?? -1);
      const team = this.slotToTeam(slot);

      return {
        accountId,
        steamId32: String(accountId),
        slot,
        team,
        heroId: member.hero_id ? Number(member.hero_id) : undefined,
      };
    });
  }

  /**
   * Get team names from current lobby
   */
  getLobbyTeamNames(): { radiant: string; dire: string } {
    if (!this._currentLobby) return { radiant: '', dire: '' };
    const lobby = this._currentLobby as Record<string, unknown>;
    return {
      radiant: String(lobby.radiant_team_name || lobby.team_name_radiant || ''),
      dire: String(lobby.dire_team_name || lobby.team_name_dire || ''),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Lobby state updates
    this.dota2.on('practiceLobbyUpdate', (lobby: unknown) => {
      this._currentLobby = lobby;
      const players = this.getCurrentLobbyPlayers();
      const teamNames = this.getLobbyTeamNames();

      this.emit('lobbyUpdate', {
        players,
        radiantTeamName: teamNames.radiant,
        direTeamName: teamNames.dire,
      });
    });

    // Chat messages in lobby
    this.dota2.on('chatMessage', (
      _channel: string,
      senderName: string,
      message: string,
      chatData: Record<string, unknown>
    ) => {
      const accountId = Number(chatData.account_id || 0);
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
      this.emit('lobbyCleared');
    });

    // Steam disconnection
    this.steam.on('disconnected', (_eresult: number, msg: string) => {
      logger.warn(`Steam disconnected: ${msg}`);
      this._connected = false;
      this._inDota = false;
      this.emit('disconnected', msg);
    });

    // Steam reconnection
    this.steam.on('loggedOn', () => {
      if (!this._connected) {
        logger.info('Steam: Reconnected');
        this._connected = true;
      }
    });
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

  private steam32ToSteam64(accountId: number): string {
    // Steam64 = accountId + 76561197960265728
    const base = BigInt('76561197960265728');
    return String(base + BigInt(accountId));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
