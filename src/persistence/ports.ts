import type { DomainEvent } from '../domain/core/events.ts'; import type { GameState,GameId,SaveId,UserId } from '../domain/core/types.ts'; import type { Snapshot } from '../domain/core/snapshot.ts';
export interface UserRecord{readonly id:UserId;readonly email:string;readonly passwordHash:string;readonly createdAt:string;}
export interface GameRecord{readonly id:GameId;readonly ownerId:UserId;readonly seed:number;readonly createdAt:string;readonly updatedAt:string;readonly currentVersion:number;readonly state:GameState;}
export interface SaveRecord{readonly id:SaveId;readonly gameId:GameId;readonly version:number;readonly snapshot:Snapshot;readonly createdAt:string;}
export interface UserRepository{findByEmail(email:string):Promise<UserRecord|null>;findById(id:UserId):Promise<UserRecord|null>;create(record:UserRecord):Promise<void>;}
export interface GameRepository{findById(id:GameId):Promise<GameRecord|null>;create(record:GameRecord):Promise<void>;update(record:GameRecord,expectedVersion:number):Promise<void>;}
export interface SaveRepository{save(record:SaveRecord):Promise<void>;findLatest(gameId:GameId):Promise<SaveRecord|null>;findById(id:SaveId):Promise<SaveRecord|null>;}
export interface EventRepository{append(events:readonly DomainEvent[]):Promise<void>;list(gameId:string,afterVersion?:number):Promise<readonly DomainEvent[]>;}
