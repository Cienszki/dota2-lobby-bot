// bot-worker/src/command-handler.ts
// Processes commands from the Firestore queue and executes them on the Dota 2 client

import type { Firestore } from 'firebase-admin/firestore';
import type { DotaClient } from './dota-client.js';
import { logger } from './logger.js';

interface BotCommand {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface CommandDocument {
  id: string;
  botAccountId: string;
  command: BotCommand;
  status: string;
  createdAt: string;
}

/**
 * Watches the Firestore command queue for a specific bot account
 * and executes commands on the Dota 2 client.
 */
export class CommandHandler {
  private isProcessing = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Commands older than this (ms) are skipped and marked as expired */
  private static readonly MAX_COMMAND_AGE_MS = 5 * 60 * 1000; // 5 minutes
  /** Warn if queue has more than this many pending commands */
  private static readonly QUEUE_SIZE_WARNING = 20;

  constructor(
    private db: Firestore,
    private botAccountId: string,
    private dotaClient: DotaClient,
    private pollIntervalMs: number = 2000
  ) {}

  /**
   * Start polling for commands
   */
  start(): void {
    logger.info(`CommandHandler: Starting command polling (${this.pollIntervalMs}ms interval)`);
    this.pollInterval = setInterval(() => this.pollAndProcess(), this.pollIntervalMs);
    // Process immediately on start
    this.pollAndProcess();
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('CommandHandler: Stopped');
  }

  /**
   * Poll for pending commands and process them sequentially
   */
  private async pollAndProcess(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const snapshot = await this.db
        .collection('botCommands')
        .doc(this.botAccountId)
        .collection('queue')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(CommandHandler.QUEUE_SIZE_WARNING + 1)
        .get();

      if (snapshot.size > CommandHandler.QUEUE_SIZE_WARNING) {
        logger.warn(
          `Command queue flood detected: ${snapshot.size}+ pending commands for bot ${this.botAccountId}. ` +
          `Possible abuse or stuck processing.`
        );
      }

      // Only process up to 5 commands per poll cycle
      const docsToProcess = snapshot.docs.slice(0, 5);

      for (const doc of docsToProcess) {
        const cmdDoc: CommandDocument = {
          id: doc.id,
          ...(doc.data() as Omit<CommandDocument, 'id'>),
        };

        // Skip commands that are too old (rate limiting / flood protection)
        const commandAge = Date.now() - new Date(cmdDoc.createdAt).getTime();
        if (commandAge > CommandHandler.MAX_COMMAND_AGE_MS) {
          await doc.ref.update({
            status: 'failed',
            processedAt: new Date().toISOString(),
            error: `Command expired (age: ${Math.round(commandAge / 1000)}s, max: ${CommandHandler.MAX_COMMAND_AGE_MS / 1000}s)`,
          });
          logger.warn(`Skipped expired command ${cmdDoc.command.type}`, {
            id: doc.id,
            ageSeconds: Math.round(commandAge / 1000),
          });
          continue;
        }

        // Mark as processing
        await doc.ref.update({ status: 'processing' });

        try {
          const result = await this.executeCommand(cmdDoc.command);
          await doc.ref.update({
            status: 'completed',
            processedAt: new Date().toISOString(),
            result: result || {},
          });
          logger.info(`Command ${cmdDoc.command.type} completed`, { id: doc.id });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await doc.ref.update({
            status: 'failed',
            processedAt: new Date().toISOString(),
            error: errorMsg,
          });
          logger.error(`Command ${cmdDoc.command.type} failed: ${errorMsg}`);
        }
      }
    } catch (error) {
      logger.error('Command polling error', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single command on the Dota 2 client
   */
  private async executeCommand(
    command: BotCommand
  ): Promise<Record<string, unknown> | null> {
    switch (command.type) {
      case 'create_lobby': {
        const settings = command.settings as Record<string, unknown>;
        await this.dotaClient.createLobby({
          name: command.lobbyName as string,
          password: command.lobbyPassword as string,
          gameMode: (settings.gameMode as number) || 2,
          serverRegion: (settings.serverRegion as number) || 8,
          visibility: (settings.visibility as number) || 2,
          dotaTvDelay: (settings.dotaTvDelay as number) || 120,
          seriesType: (settings.seriesType as number) || 0,
          leagueId: settings.leagueId as number | undefined,
          cheatsEnabled: (settings.cheatsEnabled as boolean) || false,
          fillWithBots: (settings.fillWithBots as boolean) || false,
          allowSpectators: (settings.allowSpectators as boolean) ?? true,
          pauseSetting: (settings.pauseSetting as number) || 1,
        });

        // Emit lobby_created event
        await this.emitEvent({
          type: 'lobby_created',
          sessionId: command.sessionId as string,
          dotaLobbyId: 'pending', // Will be updated by lobby update event
          timestamp: new Date().toISOString(),
        });

        return { lobbyCreated: true };
      }

      case 'invite_players': {
        const steamIds = command.steamIds as string[];
        await this.dotaClient.invitePlayers(steamIds);
        return { invited: steamIds.length };
      }

      case 'send_chat': {
        await this.dotaClient.sendChatMessage(command.message as string);
        return { messageSent: true };
      }

      case 'kick_player': {
        await this.dotaClient.kickPlayer(command.steamId32 as string);
        return { kicked: command.steamId32 };
      }

      case 'start_game': {
        await this.dotaClient.startGame();
        return { gameStarting: true };
      }

      case 'leave_lobby': {
        await this.dotaClient.leaveLobby();
        return { left: true };
      }

      case 'shutdown': {
        logger.info('Shutdown command received');
        await this.dotaClient.disconnect();
        process.exit(0);
      }

      default:
        logger.warn(`Unknown command type: ${command.type}`);
        return null;
    }
  }

  /**
   * Write an event document to Firestore for the orchestrator
   */
  private async emitEvent(event: Record<string, unknown>): Promise<void> {
    await this.db.collection('botEvents').add({
      botAccountId: this.botAccountId,
      event,
      processed: false,
      createdAt: new Date().toISOString(),
    });
  }
}
