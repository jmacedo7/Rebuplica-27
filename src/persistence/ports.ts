import type { DomainEvent } from '../domain/core/events.ts';
import type { Snapshot } from '../domain/core/snapshot.ts';
import type { GameId,GameState,SaveId,UserId } from '../domain/core/types.ts';

export interface UserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface NewUserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
}

export interface GameRecord {
  readonly id: GameId;
  readonly ownerId: UserId;
  readonly seed: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentVersion: number;
  readonly state: GameState;
}

export interface SaveRecord {
  readonly id: SaveId;
  readonly gameId: GameId;
  readonly version: number;
  readonly snapshot: Snapshot;
  readonly createdAt: string;
}

/** A persisted event together with the wall-clock instant the database recorded it. */
export interface EventRecord {
  readonly event: DomainEvent;
  readonly recordedAt: string;
}

export interface AuditEntry {
  readonly actorId: UserId | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface EventListOptions extends PageRequest {
  readonly afterVersion?: number | undefined;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: UserId): Promise<UserRecord | null>;
  create(record: NewUserRecord): Promise<UserRecord>;
}

export interface GameRepository {
  findById(id: GameId): Promise<GameRecord | null>;
  listByOwner(ownerId: UserId,page: PageRequest): Promise<Page<GameRecord>>;
  create(record: GameRecord): Promise<GameRecord>;
  /**
   * Applies the new state only when the stored version still equals `expectedVersion`
   * and returns the authoritative updated row. Throws `OptimisticConflictError` when
   * another writer already moved the version forward.
   */
  update(id: GameId,state: GameState,expectedVersion: number): Promise<GameRecord>;
}

export interface SaveRepository {
  create(record: SaveRecord): Promise<SaveRecord>;
  findById(id: SaveId): Promise<SaveRecord | null>;
  findLatest(gameId: GameId): Promise<SaveRecord | null>;
  listByGame(gameId: GameId,page: PageRequest): Promise<Page<SaveRecord>>;
}

export interface EventRepository {
  /** Appends events inside the caller's transaction; duplicate (game_id, version) fails. */
  append(events: readonly DomainEvent[]): Promise<void>;
  list(gameId: GameId,options: EventListOptions): Promise<Page<EventRecord>>;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}

/** The repositories available to a single transaction/unit of work. */
export interface Repositories {
  readonly users: UserRepository;
  readonly games: GameRepository;
  readonly saves: SaveRepository;
  readonly events: EventRepository;
  readonly audit: AuditRepository;
}

/**
 * Persistence facade. Writes always run inside `transaction`; readers may use the
 * top level repositories directly. `ping` backs the readiness probe and `close`
 * releases the connection pool during graceful shutdown.
 */
export interface Persistence extends Repositories {
  transaction<T>(operation: (repositories: Repositories) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
