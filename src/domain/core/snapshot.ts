import type { GameState } from './types.ts';
export interface Snapshot{readonly schemaVersion:number;readonly gameVersion:number;readonly state:GameState;}
export const CURRENT_SNAPSHOT_VERSION=1;
export const createSnapshot=(state:GameState,gameVersion:number):Snapshot=>({schemaVersion:CURRENT_SNAPSHOT_VERSION,gameVersion,state});
export const restoreSnapshot=(snapshot:Snapshot):GameState=>{if(snapshot.schemaVersion!==CURRENT_SNAPSHOT_VERSION)throw new Error(`Unsupported snapshot schema version: ${snapshot.schemaVersion}`);if(!Number.isInteger(snapshot.gameVersion)||snapshot.gameVersion<1)throw new Error('Invalid snapshot game version');return structuredClone(snapshot.state);};
