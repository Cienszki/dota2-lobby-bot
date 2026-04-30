// bot-worker/src/event-emitter.ts
// Emits structured events back to Firestore for the Next.js orchestrator to process

import type { Firestore } from 'firebase-admin/firestore';
import type { DotaClient, LobbyPlayerInfo, LobbyChatMessage, TeamSlotValidation } from './dota-client.js';
import { LateTimer, type LateTimerConfig } from './late-timer.js';
import { logger } from './logger.js';

interface CustomBotCommand {
  trigger: string;
  response: string;
}

/**
 * Bridges DotaClient events → Firestore event documents.
 * The orchestrator (Next.js API) polls these events and updates lobby sessions.
 */
export class EventBridge {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private previousPlayers: Map<string, LobbyPlayerInfo> = new Map();
  private gameDetected = false;
  /** Tracks whether slot validation has already emitted a slots_ready event this session */
  private slotsReadyEmitted = false;
  private customCommands: CustomBotCommand[] = [];
  private lateTimer: LateTimer | null = null;

  constructor(
    private db: Firestore,
    private botAccountId: string,
    private dotaClient: DotaClient,
    private heartbeatIntervalMs: number = 30000
  ) {}

  /** Replace the active custom command list (called after invite_players). */
  setCustomCommands(cmds: CustomBotCommand[]): void {
    this.customCommands = cmds;
  }

  /** Create and start a LateTimer for the current session. */
  startLateTimer(cfg: LateTimerConfig): void {
    this.lateTimer?.cancel();
    this.lateTimer = new LateTimer(cfg, {
      onSendChat: async (msg) => {
        await this.dotaClient.sendChatMessage(msg);
      },
      onForfeitDeclared: async (result) => {
        await this.emitEvent({
          type: 'forfeit_declared',
          sessionId: this.currentSessionId,
          forfeitType: result.forfeitType,
          forfeitedTeam: result.forfeitedTeam,
          forfeitedTeamName: result.forfeitedTeamName,
          winnerTeamName: result.winnerTeamName,
          timestamp: new Date().toISOString(),
        });
      },
      onBothTeamsAbsent: async () => {
        await this.emitEvent({
          type: 'both_teams_absent',
          sessionId: this.currentSessionId,
          timestamp: new Date().toISOString(),
        });
      },
      onWaitVotePassed: async (waitUntil) => {
        await this.emitEvent({
          type: 'wait_vote_passed',
          sessionId: this.currentSessionId,
          waitUntil: waitUntil.toISOString(),
          timestamp: new Date().toISOString(),
        });
      },
    });
    this.lateTimer.start();
    logger.info('EventBridge: LateTimer started');
  }

  /**
   * Start listening to Dota 2 client events and bridging them to Firestore
   */
  start(sessionId?: string): void {
    this.currentSessionId = sessionId || null;

    // Lobby state updates
    this.dotaClient.on('lobbyUpdate', (data: {
      players: LobbyPlayerInfo[];
      radiantTeamName: string;
      direTeamName: string;
      slotValidation: TeamSlotValidation | null;
    }) => {
      this.handleLobbyUpdate(data);
    });

    // Auto-kicked uninvited player
    this.dotaClient.on('playerKicked', (data: { accountId: number; steamId64: string; reason: string }) => {
      this.emitEvent({
        type: 'player_kicked',
        sessionId: this.currentSessionId,
        steamId32: String(data.accountId),
        reason: data.reason,
        timestamp: new Date().toISOString(),
      });
    });

    // Chat messages
    this.dotaClient.on('chatMessage', (msg: LobbyChatMessage) => {
      this.handleChatMessage(msg);
    });

    // Lobby cleared
    this.dotaClient.on('lobbyCleared', () => {
      this.handleLobbyCleared();
    });

    // Coin toss: GC resolved which team has priority (after first launchPracticeLobby)
    this.dotaClient.on('coinTossResult', (data: { priorityTeamId: string; priorityTeamId32: number }) => {
      this.emitEvent({
        type: 'coin_toss_result',
        sessionId: this.currentSessionId,
        priorityTeamId: data.priorityTeamId,
        priorityTeamId32: data.priorityTeamId32,
        timestamp: new Date().toISOString(),
      });
    });

    // Coin toss: both teams completed their side/pick-order selection — game will launch now
    this.dotaClient.on('coinTossSelectionComplete', (data: { priorityChoice: number; nonPriorityChoice: number }) => {
      this.emitEvent({
        type: 'coin_toss_selection_complete',
        sessionId: this.currentSessionId,
        priorityChoice: data.priorityChoice,
        nonPriorityChoice: data.nonPriorityChoice,
        timestamp: new Date().toISOString(),
      });
    });

    // Source TV data (for detecting game start/end)
    this.dotaClient.on('sourceTVData', (data: unknown) => {
      this.handleSourceTVData(data);
    });

    // Disconnection
    this.dotaClient.on('disconnected', (reason: string) => {
      this.emitEvent({
        type: 'bot_error',
        sessionId: this.currentSessionId,
        message: `Disconnected from Steam: ${reason}`,
        code: 'STEAM_DISCONNECT',
        timestamp: new Date().toISOString(),
      });
    });

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.sendHeartbeat();

    logger.info('EventBridge: Started');
  }

  /**
   * Stop listening and clean up
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.lateTimer?.cancel();
    this.lateTimer = null;
    this.dotaClient.removeAllListeners();
    logger.info('EventBridge: Stopped');
  }

  /**
   * Set the current session ID (when assigned to a new session)
   */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.previousPlayers.clear();
    this.gameDetected = false;
    this.slotsReadyEmitted = false;
  }

  /**
   * Clear the current session (when session is complete)
   */
  clearSession(): void {
    this.lateTimer?.cancel();
    this.lateTimer = null;
    this.customCommands = [];
    this.currentSessionId = null;
    this.previousPlayers.clear();
    this.gameDetected = false;
    this.slotsReadyEmitted = false;
  }

  // ─── Event Handlers ────────────────────────────────────────────────

  private async handleLobbyUpdate(data: {
    players: LobbyPlayerInfo[];
    radiantTeamName: string;
    direTeamName: string;
    slotValidation: TeamSlotValidation | null;
  }): Promise<void> {
    if (!this.currentSessionId) return;

    // Detect player joins/leaves/moves
    const currentPlayerMap = new Map(
      data.players.map((p) => [p.steamId32, p])
    );

    // Check for new players
    for (const [id, player] of currentPlayerMap) {
      const prev = this.previousPlayers.get(id);
      if (!prev) {
        // New player joined
        await this.emitEvent({
          type: 'player_joined',
          sessionId: this.currentSessionId,
          steamId32: player.steamId32,
          slotIndex: player.slot,
          teamSide: player.team,
          timestamp: new Date().toISOString(),
        });
      } else if (prev.slot !== player.slot || prev.team !== player.team) {
        // Player moved slots
        await this.emitEvent({
          type: 'player_slot_changed',
          sessionId: this.currentSessionId,
          steamId32: player.steamId32,
          oldSlot: prev.slot,
          newSlot: player.slot,
          teamSide: player.team,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Check for players who left
    for (const [id, prev] of this.previousPlayers) {
      if (!currentPlayerMap.has(id)) {
        await this.emitEvent({
          type: 'player_left',
          sessionId: this.currentSessionId,
          steamId32: prev.steamId32,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Update state
    this.previousPlayers = currentPlayerMap;

    // Feed current player snapshot to the late arrival timer
    this.lateTimer?.updatePlayers(data.players.map((p) => ({
      steamId32: p.steamId32,
      team: p.team,
    })));

    // Emit full lobby state update
    await this.emitEvent({
      type: 'lobby_state_update',
      sessionId: this.currentSessionId,
      players: data.players.map((p) => ({
        steamId32: p.steamId32,
        slotIndex: p.slot,
        teamSide: p.team,
      })),
      radiantTeamName: data.radiantTeamName,
      direTeamName: data.direTeamName,
      slotValidation: data.slotValidation ?? null,
      timestamp: new Date().toISOString(),
    });

    // One-shot: emit slots_ready when all players first get into correct positions
    if (data.slotValidation?.ready && !this.slotsReadyEmitted) {
      this.slotsReadyEmitted = true;
      await this.emitEvent({
        type: 'slots_ready',
        sessionId: this.currentSessionId,
        teamASide: data.slotValidation.teamASide,
        teamBSide: data.slotValidation.teamBSide,
        timestamp: new Date().toISOString(),
      });
      logger.info(`Slot validation: both teams ready — game can be started`);
    }
  }

  private async handleChatMessage(msg: LobbyChatMessage): Promise<void> {
    if (!this.currentSessionId) return;

    // Check custom bot commands first (case-insensitive, exact match)
    const normalized = msg.message.trim().toLowerCase();
    for (const cmd of this.customCommands) {
      if (normalized === cmd.trigger.toLowerCase()) {
        await this.dotaClient.sendChatMessage(cmd.response);
        return; // Don't forward bot-handled messages to Firestore
      }
    }

    // Forward chat message to late arrival timer for vote counting
    this.lateTimer?.handleChatMessage(msg.steamId32, msg.message);

    await this.emitEvent({
      type: 'chat_message',
      sessionId: this.currentSessionId,
      steamId32: msg.steamId32,
      playerName: msg.playerName,
      message: msg.message,
      currentPlayers: [...this.previousPlayers.values()].map((p) => ({
        steamId32: p.steamId32,
        teamSide: p.team as 'radiant' | 'dire' | 'spectator' | 'unassigned',
      })),
      timestamp: new Date().toISOString(),
    });
  }

  private async handleLobbyCleared(): Promise<void> {
    if (!this.currentSessionId) return;

    // If game was detected, this likely means the game ended
    if (this.gameDetected) {
      await this.emitEvent({
        type: 'game_ended',
        sessionId: this.currentSessionId,
        dotaMatchId: 0, // Will be resolved from lobby data
        radiantWin: false, // Will be resolved from match data
        duration: 0,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async handleSourceTVData(data: unknown): Promise<void> {
    if (!this.currentSessionId) return;

    // SourceTV data comes in when a game is live.
    // Structure varies, but presence of data indicates a game is running
    const tvData = data as Record<string, unknown>;

    if (!this.gameDetected && tvData) {
      this.gameDetected = true;
      // Game has started — cancel any pending late arrival timers
      this.lateTimer?.cancel();
      this.lateTimer = null;
      const matchId = tvData.match_id || tvData.matchid;
      if (matchId) {
        await this.emitEvent({
          type: 'game_started',
          sessionId: this.currentSessionId,
          dotaMatchId: Number(matchId),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────

  private async sendHeartbeat(): Promise<void> {
    try {
      await this.emitEvent({
        type: 'heartbeat',
        botAccountId: this.botAccountId,
        status: this.dotaClient.isConnected ? 'connected' : 'disconnected',
        currentSessionId: this.currentSessionId || undefined,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Heartbeat failure is non-fatal
    }
  }

  // ─── Firestore Event Writer ────────────────────────────────────────

  private async emitEvent(event: Record<string, unknown>): Promise<void> {
    try {
      await this.db.collection('botEvents').add({
        botAccountId: this.botAccountId,
        event,
        processed: false,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to emit event to Firestore', error);
    }
  }
}
