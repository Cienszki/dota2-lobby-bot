// Ambient declarations for untyped npm packages
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'steam-user' {
  import { EventEmitter } from 'events';
  class SteamUser extends EventEmitter {
    static EPersonaState: Record<string, number>;
    static EResult: Record<string, number>;
    [key: string]: any;
    constructor(options?: any);
    logOn(options: Record<string, unknown>): void;
    setPersona(state: number): void;
  }
  export = SteamUser;
}

declare module 'dota2' {
  import { EventEmitter } from 'events';
  class Dota2Client extends EventEmitter {
    [key: string]: any;
    constructor(client: any, debug?: boolean, debugMore?: boolean);
  }
  const EServerRegion: Record<string, number>;
  const DOTA_GameMode: Record<string, number>;
  const DOTALobbyVisibility: Record<string, number>;
  const schema: any;
}
