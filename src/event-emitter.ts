// bot-worker/src/event-emitter.ts
// Emits structured events back to Firestore for the Next.js orchestrator to process

import type { Firestore } from 'firebase-admin/firestore';
import type { DotaClient, LobbyPlayerInfo, LobbyChatMessage } from './dota-client.js';
import { logger } from './logger.js';

/**
 * Bridges DotaClient events → Firestore event documents.
 * The orchestrator (Next.js API) polls these events and updates lobby sessions.
 */
export class EventBridge {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private previousPlayers: Map<string, LobbyPlayerInfo> = new Map();
  private gameDetected = false;

  constructor(
    private db: Firestore,
    private botAccountId: string,
    private dotaClient: DotaClient,
    private heartbeatIntervalMs: number = 30000
  ) {}

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
    }) => {
      this.handleLobbyUpdate(data);
    });

    // Chat messages
    this.dotaClient.on('chatMessage', (msg: LobbyChatMessage) => {
      this.handleChatMessage(msg);
    });

    // Lobby cleared
    this.dotaClient.on('lobbyCleared', () => {
      this.handleLobbyCleared();
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
  }

  /**
   * Clear the current session (when session is complete)
   */
  clearSession(): void {
    this.currentSessionId = null;
    this.previousPlayers.clear();
    this.gameDetected = false;
  }

  // ─── Event Handlers ────────────────────────────────────────────────

  private async handleLobbyUpdate(data: {
    players: LobbyPlayerInfo[];
    radiantTeamName: string;
    direTeamName: string;
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
      timestamp: new Date().toISOString(),
    });
  }

  private async handleChatMessage(msg: LobbyChatMessage): Promise<void> {
    if (!this.currentSessionId) return;

    await this.emitEvent({
      type: 'chat_message',
      sessionId: this.currentSessionId,
      steamId32: msg.steamId32,
      playerName: msg.playerName,
      message: msg.message,
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
