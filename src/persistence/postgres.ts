import { Pool,type PoolClient,type PoolConfig } from 'pg';
import type { DomainEvent } from '../domain/core/events.ts';
import { parseDomainEvent,parseGameState,parseSnapshot } from '../domain/core/schema.ts';
import type { GameId,GameState,SaveId,UserId } from '../domain/core/types.ts';
import {
  DatabaseUnavailableError,
  DuplicateEventError,
  EmailConflictError,
  InvalidIdentifierError,
  InvalidStoredDataError,
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

/** PostgreSQL error codes we translate into typed persistence failures. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CONNECTIVITY_CODES: readonly string[] = Object.freeze([
  '08000','08003','08006','08001','08004','08007','08P01', // connection exceptions
  '57P01','57P02','57P03', // admin shutdown / crash / cannot connect now
  '53300', // too many connections
  'ETIMEDOUT','ECONNREFUSED','ENOTFOUND','EHOSTUNREACH','ECONNRESET','EPIPE',
]);

interface PgError {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
}

const asPgError = (value: unknown): PgError =>
  typeof value === 'object' && value !== null ? (value as PgError) : {};

const errorCodeOf = (value: unknown): string | undefined => {
  const code = asPgError(value).code;
  return typeof code === 'string' ? code : undefined;
};

const constraintOf = (value: unknown): string => {
  const constraint = asPgError(value).constraint;
  return typeof constraint === 'string' ? constraint : '';
};

export const isDatabaseUnavailable = (value: unknown): boolean => {
  const code = errorCodeOf(value);
  return code !== undefined && PG_CONNECTIVITY_CODES.includes(code);
};

const translateWriteError = (error: unknown): never => {
  const code = errorCodeOf(error);
  const constraint = constraintOf(error);
  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint.includes('users')) throw new EmailConflictError(undefined,error);
    if (constraint.includes('game_saves')) throw new SaveVersionConflictError(undefined,error);
    if (constraint.includes('game_events')) throw new DuplicateEventError(undefined,error);
  }
  if (code === PG_FOREIGN_KEY_VIOLATION) throw new InvalidStoredDataError('FOREIGN_KEY_VIOLATION',error);
  if (isDatabaseUnavailable(error)) throw new DatabaseUnavailableError(undefined,error);
  throw error;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Identifiers are validated before they reach SQL. Even though every query is
 * parameterised, PostgreSQL would abort the transaction on a malformed uuid, so
 * rejecting them early keeps error handling predictable.
 */
const requireUuid = (value: string,field: string): string => {
  if (!UUID_PATTERN.test(value)) throw new InvalidIdentifierError(`${field} must be a UUID`);
  return value;
};

const requireUuidIfPresent = (value: string | undefined,field: string): string | undefined =>
  value === undefined ? undefined : requireUuid(value,field);

const timestamp = (value: unknown,field: string): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new InvalidStoredDataError(`${field} is not a valid timestamp`);
};

const text = (value: unknown,field: string): string => {
  if (typeof value !== 'string') throw new InvalidStoredDataError(`${field} is not a string`);
  return value;
};

const integer = (value: unknown,field: string): number => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  throw new InvalidStoredDataError(`${field} is not an integer`);
};

const parseStored = <T>(factory: () => T,field: string): T => {
  try {
    return factory();
  } catch (error) {
    throw new InvalidStoredDataError(`Stored ${field} is invalid`,error);
  }
};

interface Queryable {
  query(text: string,values?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number | null }>;
}

type Row = Record<string, unknown>;

const mapUser = (row: Row): UserRecord => ({
  id: text(row['id'],'users.id'),
  email: text(row['email'],'users.email'),
  passwordHash: text(row['password_hash'],'users.password_hash'),
  createdAt: timestamp(row['created_at'],'users.created_at'),
});

const mapGame = (row: Row): GameRecord => ({
  id: text(row['id'],'games.id'),
  ownerId: text(row['owner_id'],'games.owner_id'),
  seed: integer(row['seed'],'games.seed'),
  createdAt: timestamp(row['created_at'],'games.created_at'),
  updatedAt: timestamp(row['updated_at'],'games.updated_at'),
  currentVersion: integer(row['current_version'],'games.current_version'),
  state: parseStored(() => parseGameState(row['state']),'games.state'),
});

const mapSave = (row: Row): SaveRecord => ({
  id: text(row['id'],'game_saves.id'),
  gameId: text(row['game_id'],'game_saves.game_id'),
  version: integer(row['version'],'game_saves.version'),
  createdAt: timestamp(row['created_at'],'game_saves.created_at'),
  snapshot: parseStored(
    () => parseSnapshot({schemaVersion:integer(row['schema_version'],'game_saves.schema_version'),gameVersion:integer(row['version'],'game_saves.version'),state:row['snapshot']}),
    'game_saves.snapshot',
  ),
});

const mapEvent = (row: Row): EventRecord => ({event:mapDomainEvent(row),recordedAt:timestamp(row['created_at'],'game_events.created_at')});

const mapDomainEvent = (row: Row): DomainEvent => {
  const payload = row['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidStoredDataError('game_events.payload is not an object');
  }
  const envelope = {
    type: text(row['event_type'],'game_events.event_type'),
    eventId: text(row['id'],'game_events.id'),
    version: integer(row['version'],'game_events.version'),
    ...(payload as Row),
  };
  return parseStored(() => parseDomainEvent(envelope),'game_events.payload');
};

/** Serialises a domain event into the `game_events` row shape (payload excludes the envelope). */
const serializeEvent = (event: DomainEvent): { id: string; type: string; version: number; payload: Record<string, unknown> } => {
  const { type,eventId,version,...rest } = event;
  return {id:eventId,type,version,payload:JSON.parse(JSON.stringify(rest)) as Record<string, unknown>};
};

class PostgresUserRepository implements UserRepository {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }
  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.#db.query('SELECT id, email, password_hash, created_at FROM users WHERE email = $1',[email]);
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }
  async findById(id: UserId): Promise<UserRecord | null> {
    const result = await this.#db.query('SELECT id, email, password_hash, created_at FROM users WHERE id = $1',[requireUuid(id,'users.id')]);
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }
  async create(record: NewUserRecord): Promise<UserRecord> {
    try {
      const result = await this.#db.query(
        'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, password_hash, created_at',
        [requireUuid(record.id,'users.id'),record.email,record.passwordHash],
      );
      const row = result.rows[0];
      if (row === undefined) throw new InvalidStoredDataError('users insert returned no row');
      return mapUser(row);
    } catch (error) {
      return translateWriteError(error);
    }
  }
}

class PostgresGameRepository implements GameRepository {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }
  async findById(id: GameId): Promise<GameRecord | null> {
    const result = await this.#db.query(
      'SELECT id, owner_id, seed, current_version, state, created_at, updated_at FROM games WHERE id = $1',
      [requireUuid(id,'games.id')],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapGame(row);
  }
  async listByOwner(ownerId: UserId,page: PageRequest): Promise<Page<GameRecord>> {
    const result = await this.#db.query(
      `SELECT id, owner_id, seed, current_version, state, created_at, updated_at, count(*) OVER () AS total
         FROM games
        WHERE owner_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [requireUuid(ownerId,'games.owner_id'),page.limit,page.offset],
    );
    const total = result.rows[0] === undefined ? 0 : integer(result.rows[0]['total'],'games.total');
    return {items:Object.freeze(result.rows.map(mapGame)),total,limit:page.limit,offset:page.offset};
  }
  async create(record: GameRecord): Promise<GameRecord> {
    try {
      const result = await this.#db.query(
        `INSERT INTO games (id, owner_id, seed, current_version, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id, owner_id, seed, current_version, state, created_at, updated_at`,
        [
          requireUuid(record.id,'games.id'),
          requireUuid(record.ownerId,'games.owner_id'),
          record.seed,
          record.currentVersion,
          JSON.stringify(record.state),
          record.createdAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new InvalidStoredDataError('games insert returned no row');
      return mapGame(row);
    } catch (error) {
      return translateWriteError(error);
    }
  }
  async update(id: GameId,state: GameState,expectedVersion: number): Promise<GameRecord> {
    const result = await this.#db.query(
      `UPDATE games
          SET state = $1::jsonb,
              current_version = current_version + 1,
              updated_at = now()
        WHERE id = $2 AND current_version = $3
        RETURNING id, owner_id, seed, current_version, state, created_at, updated_at`,
      [JSON.stringify(state),requireUuid(id,'games.id'),expectedVersion],
    );
    const row = result.rows[0];
    if (row === undefined) throw new OptimisticConflictError();
    return mapGame(row);
  }
}

class PostgresSaveRepository implements SaveRepository {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }
  async create(record: SaveRecord): Promise<SaveRecord> {
    try {
      const result = await this.#db.query(
        `INSERT INTO game_saves (id, game_id, version, schema_version, snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, game_id, version, schema_version, snapshot, created_at`,
        [
          requireUuid(record.id,'game_saves.id'),
          requireUuid(record.gameId,'game_saves.game_id'),
          record.version,
          record.snapshot.schemaVersion,
          JSON.stringify(record.snapshot.state),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new InvalidStoredDataError('game_saves insert returned no row');
      return mapSave(row);
    } catch (error) {
      return translateWriteError(error);
    }
  }
  async findById(id: SaveId): Promise<SaveRecord | null> {
    const result = await this.#db.query(
      'SELECT id, game_id, version, schema_version, snapshot, created_at FROM game_saves WHERE id = $1',
      [requireUuid(id,'game_saves.id')],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSave(row);
  }
  async findLatest(gameId: GameId): Promise<SaveRecord | null> {
    const result = await this.#db.query(
      `SELECT id, game_id, version, schema_version, snapshot, created_at
         FROM game_saves
        WHERE game_id = $1
        ORDER BY version DESC, created_at DESC
        LIMIT 1`,
      [requireUuid(gameId,'game_saves.game_id')],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSave(row);
  }
  async listByGame(gameId: GameId,page: PageRequest): Promise<Page<SaveRecord>> {
    const result = await this.#db.query(
      `SELECT id, game_id, version, schema_version, snapshot, created_at, count(*) OVER () AS total
         FROM game_saves
        WHERE game_id = $1
        ORDER BY version DESC, created_at DESC
        LIMIT $2 OFFSET $3`,
      [requireUuid(gameId,'game_saves.game_id'),page.limit,page.offset],
    );
    const total = result.rows[0] === undefined ? 0 : integer(result.rows[0]['total'],'game_saves.total');
    return {items:Object.freeze(result.rows.map(mapSave)),total,limit:page.limit,offset:page.offset};
  }
}

class PostgresEventRepository implements EventRepository {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }
  async append(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const gameId = events[0]?.state.gameId;
    if (gameId === undefined) throw new DuplicateEventError('EVENT_WITHOUT_GAME');
    try {
      const values: unknown[] = [requireUuid(gameId,'game_events.game_id')];
      const tuples: string[] = [];
      for (const event of events) {
        if (event.state.gameId !== gameId) throw new DuplicateEventError('EVENTS_FROM_DIFFERENT_GAMES');
        const serialized = serializeEvent(event);
        const base = values.length;
        values.push(
          requireUuid(serialized.id,'game_events.id'),
          serialized.version,
          serialized.type,
          JSON.stringify(serialized.payload),
        );
        tuples.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
      }
      await this.#db.query(
        `INSERT INTO game_events (game_id, id, version, event_type, payload) VALUES ${tuples.join(', ')}`,
        values,
      );
    } catch (error) {
      return translateWriteError(error);
    }
  }
  async list(gameId: GameId,options: EventListOptions): Promise<Page<EventRecord>> {
    const afterVersion = options.afterVersion ?? 0;
    const result = await this.#db.query(
      `SELECT id, version, event_type, payload, created_at, count(*) OVER () AS total
         FROM game_events
        WHERE game_id = $1 AND version > $2
        ORDER BY version ASC
        LIMIT $3 OFFSET $4`,
      [requireUuid(gameId,'game_events.game_id'),afterVersion,options.limit,options.offset],
    );
    const total = result.rows[0] === undefined ? 0 : integer(result.rows[0]['total'],'game_events.total');
    return {items:Object.freeze(result.rows.map(mapEvent)),total,limit:options.limit,offset:options.offset};
  }
}

class PostgresAuditRepository implements AuditRepository {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }
  async record(entry: AuditEntry): Promise<void> {
    await this.#db.query(
      'INSERT INTO audit_log (actor_id, action, resource_type, resource_id, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [
        requireUuidIfPresent(entry.actorId ?? undefined,'audit_log.actor_id') ?? null,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        JSON.stringify(entry.metadata),
      ],
    );
  }
}

/** TLS behaviour for the PostgreSQL connection. */
export type SslMode = 'disable' | 'require' | 'no-verify';

export interface PostgresPersistenceOptions {
  readonly connectionString: string;
  readonly ssl: SslMode;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly onPoolError?: ((error: Error) => void) | undefined;
}

export interface PostgresPersistence extends Persistence {
  readonly pool: Pool;
}

export const resolveSslConfig = (mode: SslMode): PoolConfig['ssl'] => {
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return {rejectUnauthorized:false};
  return {rejectUnauthorized:true};
};

export const buildPoolConfig = (options: PostgresPersistenceOptions): PoolConfig => ({
  connectionString: options.connectionString,
  max: options.poolMax,
  connectionTimeoutMillis: options.connectionTimeoutMs,
  idleTimeoutMillis: options.idleTimeoutMs,
  statement_timeout: options.statementTimeoutMs,
  application_name: 'rebuplica-27',
  ssl: resolveSslConfig(options.ssl),
});

export const createPostgresPool = (options: PostgresPersistenceOptions): Pool => {
  const pool = new Pool(buildPoolConfig(options));
  // Idle client failures are emitted on the pool, not on a query: without a listener
  // Node would crash the process on an unhandled 'error' event.
  pool.on('error',(error: Error) => { options.onPoolError?.(error); });
  return pool;
};

const queryAdapter = (client: Pool | PoolClient): Queryable => ({
  query: async (statement,values) => {
    try {
      const result = await client.query(statement,values === undefined ? undefined : [...values]);
      return {rows:result.rows as Row[],rowCount:result.rowCount};
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw new DatabaseUnavailableError(undefined,error);
      throw error;
    }
  },
});

export const createPostgresPersistence = (options: PostgresPersistenceOptions): PostgresPersistence => {
  const pool = createPostgresPool(options);
  const root = queryAdapter(pool);
  const repositories: Repositories = {
    users: new PostgresUserRepository(root),
    games: new PostgresGameRepository(root),
    saves: new PostgresSaveRepository(root),
    events: new PostgresEventRepository(root),
    audit: new PostgresAuditRepository(root),
  };
  return {
    pool,
    ...repositories,
    transaction: async <T>(operation: (repositories: Repositories) => Promise<T>): Promise<T> => {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw new DatabaseUnavailableError('Could not acquire a database connection',error);
      }
      const scoped = queryAdapter(client);
      const scopedRepositories: Repositories = {
        users: new PostgresUserRepository(scoped),
        games: new PostgresGameRepository(scoped),
        saves: new PostgresSaveRepository(scoped),
        events: new PostgresEventRepository(scoped),
        audit: new PostgresAuditRepository(scoped),
      };
      try {
        await client.query('BEGIN');
        const result = await operation(scopedRepositories);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // A failed rollback means the connection is broken; release() discards it.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    ping: async () => {
      try {
        await pool.query('SELECT 1');
      } catch (error) {
        throw new DatabaseUnavailableError('Database is not reachable',error);
      }
    },
    close: async () => {
      await pool.end();
    },
  };
};
