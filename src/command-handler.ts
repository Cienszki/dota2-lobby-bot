// bot-worker/src/command-handler.ts
// Processes commands from the Firestore queue and executes them on the Dota 2 client

import type { Firestore } from 'firebase-admin/firestore';
import type { DotaClient } from './dota-client.js';
import type { EventBridge } from './event-emitter.js';
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
    private pollIntervalMs: number = 2000,
    private eventBridge?: EventBridge
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
          // Session-level seriesType (from match format) overrides global lobby config
          seriesType: (command.seriesTypeOverride as number) ?? (settings.seriesType as number) ?? 0,
          radiantSeriesWins: command.radiantSeriesWins as number | undefined,
          direSeriesWins: command.direSeriesWins as number | undefined,
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
        // Optional team assignments: if provided, configure auto-kick + slot validation
        // before sending any invites so the guard is active from the moment players join.
        const teamA = command.teamA as string[] | undefined;
        const teamB = command.teamB as string[] | undefined;
        const whitelist = command.whitelist as string[] | undefined;
        if (teamA && teamB) {
          this.dotaClient.setSessionTeams(teamA, teamB, whitelist ?? []);
        }
        // Support both flat steamIds array and derived from teamA+teamB
        const steamIds: string[] = teamA && teamB
          ? [...teamA, ...teamB]
          : (command.steamIds as string[]);
        await this.dotaClient.invitePlayers(steamIds);

        // Configure EventBridge for this session
        if (this.eventBridge) {
          // Wire custom bot commands
          const customCommands = command.customCommands as Array<{ trigger: string; response: string }> | undefined;
          this.eventBridge.setCustomCommands(customCommands ?? []);

          // Wire late arrival timer
          const latePolicy = command.latePolicy as Record<string, unknown> | undefined;
          const scheduledMatchTime = command.scheduledMatchTime as string | undefined;
          if (latePolicy?.enabled && scheduledMatchTime && teamA && teamB) {
            const radiantTeamName = (command.radiantTeamName as string | undefined) ?? 'Radiant';
            const direTeamName = (command.direTeamName as string | undefined) ?? 'Dire';
            this.eventBridge.startLateTimer({
              scheduledMatchTime: new Date(scheduledMatchTime),
              radiantSteamIds: teamA,
              direSteamIds: teamB,
              radiantTeamName,
              direTeamName,
              game1ForfeitMinutes: (latePolicy.game1ForfeitMinutes as number) ?? 15,
              seriesForfeitMinutes: (latePolicy.seriesForfeitMinutes as number) ?? 30,
              waitCommands: (latePolicy.waitCommands as string[]) ?? ['!wait'],
              forfeitCommands: (latePolicy.forfeitCommands as string[]) ?? ['!forfeit'],
              votingWindowSeconds: (latePolicy.votingWindowSeconds as number) ?? 60,
              requiredVotesForForfeit: (latePolicy.requiredVotesForForfeit as number) ?? 3,
              lateGame1AnnouncementTemplate: (latePolicy.lateGame1AnnouncementTemplate as string) ?? (latePolicy.lateAnnouncementTemplate as string) ?? '{late_team} is late (game 1). {present_team}, vote: {wait_cmd} to wait or {forfeit_cmd} to forfeit. {window}s window.',
              lateSeriesAnnouncementTemplate: (latePolicy.lateSeriesAnnouncementTemplate as string) ?? (latePolicy.lateAnnouncementTemplate as string) ?? '{late_team} is late (series). {present_team}, vote: {wait_cmd} to wait or {forfeit_cmd} to forfeit. {window}s window.',
              waitResultTemplate: (latePolicy.waitResultTemplate as string) ?? 'Vote: wait. Extra {extra} minutes for {loser_team}.',
              forfeitGame1Template: (latePolicy.forfeitGame1Template as string) ?? 'Game 1 forfeit: {winner_team} wins!',
              forfeitSeriesTemplate: (latePolicy.forfeitSeriesTemplate as string) ?? 'Series forfeit: {winner_team} wins!',
              noVoteResultTemplate: (latePolicy.noVoteResultTemplate as string) ?? 'Not enough votes ({votes}/{required}). Waiting for admin.',
            });
          }
        }

        return { invited: steamIds.length };
      }

      case 'set_teams': {
        // Standalone command to configure team assignments without re-inviting.
        // Useful when teams are known before the lobby is created.
        const teamA = command.teamA as string[];
        const teamB = command.teamB as string[];
        const whitelist = command.whitelist as string[] | undefined;
        this.dotaClient.setSessionTeams(teamA, teamB, whitelist ?? []);
        return { teamsSet: true, teamACount: teamA.length, teamBCount: teamB.length };
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
