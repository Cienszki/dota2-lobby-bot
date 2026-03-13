// bot-worker/README.md
# Dota 2 Lobby Bot Worker

This is a **standalone Node.js process** that runs a Dota 2 game client to manage lobby creation, player management, and match lifecycle.

## Architecture

```
┌─────────────────────────────────────────────┐
│           Next.js Application                │
│  ┌───────────────────────────────────────┐  │
│  │  Admin Panel (Bot Tab)                │  │
│  │  - Configure lobby settings           │  │
│  │  - Manage bot accounts                │  │
│  │  - Monitor active lobbies             │  │
│  └───────────────┬───────────────────────┘  │
│                   │                          │
│  ┌───────────────▼───────────────────────┐  │
│  │  Bot Orchestrator (API Routes)        │  │
│  │  - Schedule lobby sessions            │  │
│  │  - Assign bots to sessions            │  │
│  │  - Process bot events                 │  │
│  │  - Trigger match sync                 │  │
│  └───────────────┬───────────────────────┘  │
│                   │                          │
│     Firestore (Command Queue + Events)      │
│                   │                          │
└───────────────────┼──────────────────────────┘
                    │
      ┌─────────────▼─────────────┐
      │   Bot Worker Process(es)   │
      │                            │
      │  ┌──────────────────────┐  │
      │  │  Steam Client        │  │
      │  │  (node-steam-user)   │  │
      │  └──────────┬───────────┘  │
      │             │              │
      │  ┌──────────▼───────────┐  │
      │  │  Dota 2 GC Client    │  │
      │  │  (node-dota2)        │  │
      │  │                      │  │
      │  │  - Create lobbies    │  │
      │  │  - Invite players    │  │
      │  │  - Monitor chat      │  │
      │  │  - Track game state  │  │
      │  │  - Observe matches   │  │
      │  └──────────────────────┘  │
      │                            │
      │  One process per bot       │
      │  account (Dota 2 limits    │
      │  one lobby per client)     │
      └────────────────────────────┘
```

## Communication Protocol

The bot-worker communicates with the Next.js orchestrator via **Firestore documents** acting as a message queue:

### Commands (Orchestrator → Worker)
- Stored at: `/botCommands/{botAccountId}/queue/{commandId}`
- Worker watches for new documents with `status: 'pending'`
- Types: `create_lobby`, `invite_players`, `send_chat`, `kick_player`, `start_game`, `leave_lobby`, `shutdown`

### Events (Worker → Orchestrator)
- Stored at: `/botEvents/{eventId}`
- Orchestrator polls for `processed: false` events
- Types: `lobby_created`, `player_joined`, `chat_message`, `game_started`, `game_ended`, etc.

## Prerequisites

- Node.js 18+
- A Steam account with Dota 2 installed (for the bot)
- Steam Guard must be disabled or handled via shared secret
- The bot's Steam account should have a Dota 2 game license

## Setup

```bash
cd bot-worker
npm install
cp .env.example .env
# Edit .env with bot credentials and Firebase config
```

## Running

```bash
# Single bot instance
npm start -- --bot-id=<bot_account_id>

# Or with environment variable
BOT_ACCOUNT_ID=abc123 npm start
```

## Scaling

Each bot account runs as a **separate process**. For multiple concurrent matches:
1. Register multiple bot accounts in the admin panel
2. Run one worker process per bot account
3. The Bot Pool Manager automatically assigns sessions to available bots

In production, use Docker containers or Cloud Run instances — one per bot account.

## Key Dependencies

- `steam-user` - Steam client connection
- `dota2` - Dota 2 Game Coordinator protocol (node-dota2)
- `firebase-admin` - Firestore for command/event queue
