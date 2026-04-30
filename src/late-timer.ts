// bot-worker/src/late-timer.ts
// Tracks scheduled match start time and manages the late-player forfeit voting flow.
//
// State machine:
//   idle → monitoring (bot starts timer at scheduled match time)
//   monitoring → voting (one team is absent; opposing team votes)
//   voting → waiting (majority votes wait → 10 min extension)
//   voting → resolved_forfeit (majority votes forfeit → emit forfeit event)
//   voting → no_quorum (not enough votes → return to monitoring until next threshold)
//   * → cancelled (game started; timers cleared)
//
// Only votes from the OPPOSING (present) team's expected Steam32 IDs are counted.
// The voting window is configurable (default 60s). Need N/5 votes to trigger forfeit.

import { logger } from './logger.js';

export interface LateTimerConfig {
  /** ISO timestamp of the scheduled match start */
  scheduledMatchTime: Date;
  /** Steam32 IDs of Radiant roster (as they sit in LobbySession.radiantTeam.expectedPlayers) */
  radiantSteamIds: string[];
  /** Steam32 IDs of Dire roster */
  direSteamIds: string[];
  radiantTeamName: string;
  direTeamName: string;
  game1ForfeitMinutes: number;
  seriesForfeitMinutes: number;
  /** Minutes added when the present team votes to wait (default 10) */
  waitExtensionMinutes: number;
  waitCommands: string[];
  forfeitCommands: string[];
  votingWindowSeconds: number;
  requiredVotesForForfeit: number;
  lateGame1AnnouncementTemplate: string;
  lateSeriesAnnouncementTemplate: string;
  waitResultTemplate: string;
  forfeitGame1Template: string;
  forfeitSeriesTemplate: string;
  noVoteResultTemplate: string;
}

export interface LateTimerCallbacks {
  onSendChat: (msg: string) => Promise<void>;
  onForfeitDeclared: (result: {
    forfeitType: 'game1' | 'series';
    forfeitedTeam: 'radiant' | 'dire';
    forfeitedTeamName: string;
    winnerTeamName: string;
  }) => Promise<void>;
  onBothTeamsAbsent: () => Promise<void>;
  /** Called when the present team votes to wait, with the ISO timestamp until which the orchestrator should not time out the session. */
  onWaitVotePassed?: (waitUntil: Date) => Promise<void>;
}

interface LobbyPlayerSnapshot {
  steamId32: string;
  team: 'radiant' | 'dire' | 'spectator' | 'unassigned';
}

type LateTimerPhase =
  | 'idle'
  | 'monitoring'
  | 'voting_game1'
  | 'voting_series'
  | 'waiting_after_game1'
  | 'resolved'
  | 'cancelled';

export class LateTimer {
  private phase: LateTimerPhase = 'idle';
  private currentPlayers: LobbyPlayerSnapshot[] = [];
  private votes = new Map<string, 'wait' | 'forfeit'>();
  private activeVoteTeamSteamIds = new Set<string>();
  private activeVoteLateTeam: 'radiant' | 'dire' | null = null;

  // Timers
  private game1Timer: ReturnType<typeof setTimeout> | null = null;
  private seriesTimer: ReturnType<typeof setTimeout> | null = null;
  private voteTimer: ReturnType<typeof setTimeout> | null = null;

  // Track whether game1 vote already ran (even without forfeit) so series timer
  // doesn't re-check game1 threshold
  private game1CheckDone = false;

  private readonly radiantSet: Set<string>;
  private readonly direSet: Set<string>;

  constructor(
    private readonly cfg: LateTimerConfig,
    private readonly callbacks: LateTimerCallbacks
  ) {
    this.radiantSet = new Set(cfg.radiantSteamIds);
    this.direSet = new Set(cfg.direSteamIds);
  }

  /** Call once the lobby is open and the match is scheduled. */
  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'monitoring';

    const now = Date.now();
    const matchMs = this.cfg.scheduledMatchTime.getTime();

    const game1Delay = Math.max(0, matchMs + this.cfg.game1ForfeitMinutes * 60_000 - now);
    const seriesDelay = Math.max(0, matchMs + this.cfg.seriesForfeitMinutes * 60_000 - now);

    logger.info(
      `LateTimer: started. Game1 check in ${Math.round(game1Delay / 1000)}s, ` +
      `Series check in ${Math.round(seriesDelay / 1000)}s`
    );

    this.game1Timer = setTimeout(() => {
      this.game1CheckDone = true;
      this.initiateVoteIfLate('game1');
    }, game1Delay);

    this.seriesTimer = setTimeout(() => {
      this.initiateVoteIfLate('series');
    }, seriesDelay);
  }

  /**
   * Called by EventBridge on every lobby state update.
   * Players with team === 'radiant' | 'dire' are considered seated/present.
   */
  updatePlayers(players: LobbyPlayerSnapshot[]): void {
    this.currentPlayers = players;
  }

  /**
   * Called by EventBridge for every incoming chat message.
   * Only acts if a vote is currently active.
   */
  handleChatMessage(steamId32: string, message: string): void {
    if (this.phase !== 'voting_game1' && this.phase !== 'voting_series') return;
    if (!this.activeVoteTeamSteamIds.has(steamId32)) return; // Not from the voting team

    const normalized = message.trim().toLowerCase();
    if (this.cfg.waitCommands.includes(normalized)) {
      this.votes.set(steamId32, 'wait');
      logger.debug(`LateTimer: ${steamId32} voted WAIT`);
    } else if (this.cfg.forfeitCommands.includes(normalized)) {
      this.votes.set(steamId32, 'forfeit');
      logger.debug(`LateTimer: ${steamId32} voted FORFEIT`);
    }
  }

  /** Cancel all timers (called when game starts or session ends). */
  cancel(): void {
    this.phase = 'cancelled';
    this.clearAllTimers();
    logger.info('LateTimer: cancelled');
  }

  // ─── Private ──────────────────────────────────────────────────────

  private initiateVoteIfLate(type: 'game1' | 'series'): void {
    if (this.phase === 'cancelled' || this.phase === 'resolved') return;

    // If still in a waiting period from game1 vote, let the series timer decide
    if (type === 'game1' && this.phase === 'waiting_after_game1') return;

    // Determine which team is absent
    const radiantPresent = this.countSeated(this.radiantSet);
    const direPresent = this.countSeated(this.direSet);

    const radiantFull = radiantPresent >= 5;
    const direFull = direPresent >= 5;

    if (radiantFull && direFull) {
      logger.debug(`LateTimer: All players present at ${type} check — no vote needed`);
      return;
    }

    if (!radiantFull && !direFull) {
      // Both teams absent — can't vote; notify admin
      logger.warn(
        `LateTimer: Both teams absent at ${type} check (radiant: ${radiantPresent}/5, dire: ${direPresent}/5)`
      );
      void this.callbacks.onBothTeamsAbsent();
      return;
    }

    const lateTeam: 'radiant' | 'dire' = radiantFull ? 'dire' : 'radiant';
    const lateTeamName = lateTeam === 'radiant' ? this.cfg.radiantTeamName : this.cfg.direTeamName;
    const presentTeamName = lateTeam === 'radiant' ? this.cfg.direTeamName : this.cfg.radiantTeamName;
    const presentTeamSteamIds = lateTeam === 'radiant'
      ? [...this.direSet]
      : [...this.radiantSet];
    const minutesLate = type === 'game1'
      ? this.cfg.game1ForfeitMinutes
      : this.cfg.seriesForfeitMinutes;

    this.startVote(type, lateTeam, lateTeamName, presentTeamName, presentTeamSteamIds, minutesLate);
  }

  private startVote(
    type: 'game1' | 'series',
    lateTeam: 'radiant' | 'dire',
    lateTeamName: string,
    presentTeamName: string,
    presentTeamSteamIds: string[],
    minutesLate: number
  ): void {
    this.phase = type === 'game1' ? 'voting_game1' : 'voting_series';
    this.votes.clear();
    this.activeVoteTeamSteamIds = new Set(presentTeamSteamIds);
    this.activeVoteLateTeam = lateTeam;

    const waitCmd = this.cfg.waitCommands[0] ?? '!wait';
    const forfeitCmd = this.cfg.forfeitCommands[0] ?? '!forfeit';

    const template = type === 'game1'
      ? this.cfg.lateGame1AnnouncementTemplate
      : this.cfg.lateSeriesAnnouncementTemplate;
    const msg = this.fill(template, {
      late_team: lateTeamName,
      present_team: presentTeamName,
      minutes: String(minutesLate),
      wait_cmd: waitCmd,
      forfeit_cmd: forfeitCmd,
      window: String(this.cfg.votingWindowSeconds),
      required: String(this.cfg.requiredVotesForForfeit),
    });

    logger.info(`LateTimer: Starting ${type} vote. Late: ${lateTeamName}. Voters: ${presentTeamName}`);
    void this.callbacks.onSendChat(msg);

    this.voteTimer = setTimeout(() => {
      this.tallyVote(type, lateTeam, lateTeamName, presentTeamName);
    }, this.cfg.votingWindowSeconds * 1000);
  }

  private tallyVote(
    type: 'game1' | 'series',
    lateTeam: 'radiant' | 'dire',
    lateTeamName: string,
    presentTeamName: string
  ): void {
    const forfeitVotes = [...this.votes.values()].filter((v) => v === 'forfeit').length;
    const waitVotes = [...this.votes.values()].filter((v) => v === 'wait').length;
    const totalVotes = forfeitVotes + waitVotes;

    logger.info(
      `LateTimer: ${type} vote tallied — forfeit: ${forfeitVotes}, wait: ${waitVotes}, ` +
      `required: ${this.cfg.requiredVotesForForfeit}`
    );

    if (forfeitVotes >= this.cfg.requiredVotesForForfeit) {
      const template =
        type === 'game1' ? this.cfg.forfeitGame1Template : this.cfg.forfeitSeriesTemplate;
      void this.callbacks.onSendChat(
        this.fill(template, { winner_team: presentTeamName, loser_team: lateTeamName })
      );
      this.phase = 'resolved';
      void this.callbacks.onForfeitDeclared({
        forfeitType: type,
        forfeitedTeam: lateTeam,
        forfeitedTeamName: lateTeamName,
        winnerTeamName: presentTeamName,
      });

    } else if (waitVotes >= this.cfg.requiredVotesForForfeit) {
      const extraMinutes = this.cfg.waitExtensionMinutes;
      void this.callbacks.onSendChat(
        this.fill(this.cfg.waitResultTemplate, {
          present_team: presentTeamName,
          extra: String(extraMinutes),
        })
      );
      const waitUntil = new Date(Date.now() + extraMinutes * 60_000);
      if (this.callbacks.onWaitVotePassed) {
        void this.callbacks.onWaitVotePassed(waitUntil);
      }
      // After 10 minutes, re-check the same threshold (only allowed once per threshold)
      this.phase = 'waiting_after_game1';
      logger.info(`LateTimer: Wait vote passed — re-checking in ${extraMinutes} min`);
      setTimeout(() => {
        if (this.phase === 'waiting_after_game1') {
          this.phase = 'monitoring';
          this.initiateVoteIfLate(type);
        }
      }, extraMinutes * 60_000);

    } else {
      // Not enough votes either way
      void this.callbacks.onSendChat(
        this.fill(this.cfg.noVoteResultTemplate, {
          votes: String(totalVotes),
          required: String(this.cfg.requiredVotesForForfeit),
          present_team: presentTeamName,
        })
      );
      this.phase = 'monitoring';
    }

    this.votes.clear();
    this.activeVoteTeamSteamIds.clear();
    this.activeVoteLateTeam = null;
  }

  /** Count how many of the given team's Steam32 IDs are seated in a player slot. */
  private countSeated(teamSet: Set<string>): number {
    return this.currentPlayers.filter(
      (p) => teamSet.has(p.steamId32) && (p.team === 'radiant' || p.team === 'dire')
    ).length;
  }

  private fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
  }

  private clearAllTimers(): void {
    if (this.game1Timer) { clearTimeout(this.game1Timer); this.game1Timer = null; }
    if (this.seriesTimer) { clearTimeout(this.seriesTimer); this.seriesTimer = null; }
    if (this.voteTimer) { clearTimeout(this.voteTimer); this.voteTimer = null; }
  }
}
