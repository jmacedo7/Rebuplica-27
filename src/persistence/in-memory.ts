/**
 * In-memory persistence.
 *
 * TEST ONLY: this adapter exists so unit and API tests can run without a database.
 * The runtime (`src/main.ts`) always builds the PostgreSQL persistence, and there is
 * no environment flag that switches production back to memory.
 */
import type { DomainEvent } from '../domain/core/events.ts';
import { parseDomainEvent,parseGameState } from '../domain/core/schema.ts';
import type { GameId,GameState,SaveId,UserId } from '../domain/core/types.ts';
import {
  DuplicateEventError,
  EmailConflictError,
  OptimisticConflictError,
  SaveVersionConflictError,
} from './errors.ts';
import type {
  AuditEntry,
  AuditRepository,
  EventListOptions,
  EventRecord,
  EventRepository,
  GameRecord,
  GameRepository,
  NewUserRecord,
  Page,
  PageRequest,
  Persistence,
  Repositories,
  SaveRecord,
  SaveRepository,
  UserRecord,
  UserRepository,
} from './ports.ts';

const clone = <T>(value: T): T => structuredClone(value);
const nowIso = (): string => new Date().toISOString();

const pageOf = <T>(items: readonly T[],total: number,page: PageRequest): Page<T> =>
  Object.freeze({items:Object.freeze([...items]),total,limit:page.limit,offset:page.offset});

class InMemoryUserRepository implements UserRepository {
  readonly records = new Map<UserId,UserRecord>();
  async findByEmail(email: string): Promise<UserRecord | null> {
    for (const record of this.records.values()) if (record.email === email) return clone(record);
    return null;
  }
  async findById(id: UserId): Promise<UserRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : clone(record);
  }
  async create(record: NewUserRecord): Promise<UserRecord> {
    for (const existing of this.records.values()) {
      if (existing.email === record.email) throw new EmailConflictError();
    }
    if (this.records.has(record.id)) throw new EmailConflictError('USER_ID_CONFLICT');
    const stored: UserRecord = {...clone(record),createdAt:nowIso()};
    this.records.set(stored.id,stored);
    return clone(stored);
  }
}

class InMemoryGameRepository implements GameRepository {
  readonly records = new Map<GameId,GameRecord>();
  async findById(id: GameId): Promise<GameRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : clone(record);
  }
  async listByOwner(ownerId: UserId,page: PageRequest): Promise<Page<GameRecord>> {
    const owned = [...this.records.values()]
      .filter(record => record.ownerId === ownerId)
      .sort((left,right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return pageOf(owned.slice(page.offset,page.offset + page.limit).map(clone),owned.length,page);
  }
  async create(record: GameRecord): Promise<GameRecord> {
    if (this.records.has(record.id)) throw new OptimisticConflictError('GAME_ID_CONFLICT');
    const stored = clone(record);
    this.records.set(stored.id,stored);
    return clone(stored);
  }
  async update(id: GameId,state: GameState,expectedVersion: number): Promise<GameRecord> {
    const current = this.records.get(id);
    if (current === undefined || current.currentVersion !== expectedVersion) throw new OptimisticConflictError();
    const updated: GameRecord = {
      ...current,
      state:clone(state),
      currentVersion:expectedVersion + 1,
      updatedAt:nowIso(),
    };
    this.records.set(id,updated);
    return clone(updated);
  }
}

class InMemorySaveRepository implements SaveRepository {
  readonly records = new Map<SaveId,SaveRecord>();
  async create(record: SaveRecord): Promise<SaveRecord> {
    for (const existing of this.records.values()) {
      if (existing.gameId === record.gameId && existing.version === record.version) throw new SaveVersionConflictError();
    }
    const stored = clone(record);
    this.records.set(stored.id,stored);
    return clone(stored);
  }
  async findById(id: SaveId): Promise<SaveRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : clone(record);
  }
  async findLatest(gameId: GameId): Promise<SaveRecord | null> {
    const saves = [...this.records.values()]
      .filter(record => record.gameId === gameId)
      .sort((left,right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
    const latest = saves[0];
    return latest === undefined ? null : clone(latest);
  }
  async listByGame(gameId: GameId,page: PageRequest): Promise<Page<SaveRecord>> {
    const saves = [...this.records.values()]
      .filter(record => record.gameId === gameId)
      .sort((left,right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
    return pageOf(saves.slice(page.offset,page.offset + page.limit).map(clone),saves.length,page);
  }
}

class InMemoryEventRepository implements EventRepository {
  readonly records: EventRecord[] = [];
  async append(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const state = parseGameState(event.state);
      if (state.gameId === '') throw new DuplicateEventError('EVENT_WITHOUT_GAME');
      if (this.records.some(existing => existing.event.state.gameId === state.gameId && existing.event.version === event.version)) {
        throw new DuplicateEventError();
      }
      this.records.push({event:parseDomainEvent(clone(event)),recordedAt:nowIso()});
    }
  }
  async list(gameId: GameId,options: EventListOptions): Promise<Page<EventRecord>> {
    const afterVersion = options.afterVersion ?? 0;
    const matching = this.records
      .filter(record => record.event.state.gameId === gameId && record.event.version > afterVersion)
      .sort((left,right) => left.event.version - right.event.version);
    const page = matching.slice(options.offset,options.offset + options.limit).map(clone);
    return pageOf(page,matching.length,options);
  }
}

class InMemoryAuditRepository implements AuditRepository {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(clone(entry));
  }
}

/**
 * Serialises transactions so concurrent unit-of-work bodies observe the same
 * "one writer at a time" property the PostgreSQL transactions provide.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation,operation);
    this.#tail = result.then(() => undefined,() => undefined);
    return result;
  }
}

export interface InMemoryPersistence extends Persistence {
  readonly users: InMemoryUserRepository;
  readonly games: InMemoryGameRepository;
  readonly saves: InMemorySaveRepository;
  readonly events: InMemoryEventRepository;
  readonly audit: InMemoryAuditRepository;
}

export const createInMemoryPersistence = (): InMemoryPersistence => {
  const users = new InMemoryUserRepository();
  const games = new InMemoryGameRepository();
  const saves = new InMemorySaveRepository();
  const events = new InMemoryEventRepository();
  const audit = new InMemoryAuditRepository();
  const repositories: Repositories = {users,games,saves,events,audit};
  const mutex = new Mutex();
  return {
    users,
    games,
    saves,
    events,
    audit,
    transaction: operation => mutex.run(() => operation(repositories)),
    ping: async () => undefined,
    close: async () => undefined,
  };
};

// Kept for backwards compatibility with the original foundation module.
export class InMemoryRepositories {
  readonly users = new InMemoryUserRepository();
  readonly games = new InMemoryGameRepository();
  readonly saves = new InMemorySaveRepository();
  readonly events = new InMemoryEventRepository();
  readonly audit = new InMemoryAuditRepository();
}
