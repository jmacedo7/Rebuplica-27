import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client,type ClientConfig } from 'pg';
import { isDatabaseUnavailable } from './postgres.ts';
import { DatabaseUnavailableError } from './errors.ts';
import type { SslMode } from './postgres.ts';

/** `db/migrations` relative to the repository root, valid from `src/` and from `dist/`. */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../db/migrations/',import.meta.url));

const FILENAME_PATTERN = /^(\d{4})_([A-Za-z0-9_-]+)\.sql$/u;
const ADVISORY_LOCK_KEY = 'rebuplica-27:migrations';

export interface MigrationFile {
  /** Zero padded ordering prefix, e.g. `0001`. */
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationStatusEntry {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied: boolean;
  readonly appliedAt: string | null;
  /** False when an applied migration file changed after being applied. */
  readonly checksumMatches: boolean;
}

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface MigrationOptions {
  readonly connectionString: string;
  readonly ssl: SslMode;
  readonly directory?: string | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/gu,'\n'),'utf8').digest('hex');

export const loadMigrations = (directory: string = MIGRATIONS_DIRECTORY): readonly MigrationFile[] => {
  const files = readdirSync(directory,{withFileTypes:true})
    .filter(entry => entry.isFile() && FILENAME_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort((left,right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No migration files found in ${directory}`);
  return files.map(file => {
    const match = FILENAME_PATTERN.exec(file);
    if (match === null) throw new Error(`Unexpected migration file name: ${file}`);
    const [,version,name] = match;
    if (version === undefined || name === undefined) throw new Error(`Unexpected migration file name: ${file}`);
    const sql = readFileSync(join(directory,file),'utf8');
    return Object.freeze({version,name,path:join(directory,file),sql,checksum:checksumOf(sql)});
  });
};

const clientConfig = (options: MigrationOptions): ClientConfig => ({
  connectionString: options.connectionString,
  application_name: 'rebuplica-27-migrations',
  ssl: options.ssl === 'disable' ? false : {rejectUnauthorized:options.ssl === 'require'},
});

const withClient = async <T>(options: MigrationOptions,operation: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client(clientConfig(options));
  try {
    await client.connect();
  } catch (error) {
    throw new DatabaseUnavailableError('Could not connect to PostgreSQL to run migrations',error);
  }
  try {
    return await operation(client);
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw new DatabaseUnavailableError('Migration run lost the database connection',error);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
};

const ensureMigrationsTable = async (client: Client): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

const readApplied = async (client: Client): Promise<readonly AppliedMigration[]> => {
  const result = await client.query<{version: string; name: string; checksum: string; applied_at: Date}>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  );
  return result.rows.map(row => ({
    version:row.version,
    name:row.name,
    checksum:row.checksum,
    appliedAt:row.applied_at.toISOString(),
  }));
};

/**
 * Applies pending migrations in order, each inside its own transaction, while holding
 * an advisory lock so two deploy jobs cannot race. Already applied migrations are
 * verified by checksum: editing an applied file is an error, add a new migration.
 */
export const applyMigrations = async (options: MigrationOptions): Promise<MigrationReport> =>
  withClient(options,async client => {
    const log = options.onLog ?? ((): void => undefined);
    await client.query('SELECT pg_advisory_lock(hashtext($1))',[ADVISORY_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);
      const applied = new Map((await readApplied(client)).map(entry => [entry.version,entry]));
      const appliedNow: string[] = [];
      const skipped: string[] = [];
      for (const migration of loadMigrations(options.directory ?? MIGRATIONS_DIRECTORY)) {
        const previous = applied.get(migration.version);
        if (previous !== undefined) {
          if (previous.checksum !== migration.checksum) {
            throw new Error(`Migration ${migration.version}_${migration.name} changed after it was applied; create a new migration instead`);
          }
          skipped.push(migration.version);
          continue;
        }
        log(`applying ${migration.version}_${migration.name}`);
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version,migration.name,migration.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${migration.version}_${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,{cause:error});
        }
        appliedNow.push(migration.version);
      }
      return {applied:appliedNow,skipped};
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))',[ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  });

/** Read-only report of the migration state; never mutates the database. */
export const migrationStatus = async (options: MigrationOptions): Promise<readonly MigrationStatusEntry[]> =>
  withClient(options,async client => {
    await ensureMigrationsTable(client);
    const applied = new Map((await readApplied(client)).map(entry => [entry.version,entry]));
    return loadMigrations(options.directory ?? MIGRATIONS_DIRECTORY).map(migration => {
      const previous = applied.get(migration.version);
      return {
        version:migration.version,
        name:migration.name,
        checksum:migration.checksum,
        applied:previous !== undefined,
        appliedAt:previous?.appliedAt ?? null,
        checksumMatches:previous === undefined || previous.checksum === migration.checksum,
      };
    });
  });
