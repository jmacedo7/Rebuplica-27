import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { applyMigrations,type MigrationReport } from '../../src/persistence/migrations.ts';
import type { PostgresPersistenceOptions } from '../../src/persistence/postgres.ts';

/**
 * PostgreSQL provisioning for integration tests.
 *
 * `TEST_DATABASE_URL` (falling back to `DATABASE_URL`) must point at a database the
 * test user can create databases in. Each test file gets its own throwaway database,
 * so files can run in parallel without truncating each other's data. When the server
 * does not grant CREATEDB the helper falls back to the configured database itself and
 * truncates the tables before use.
 */
export const baseDatabaseUrl: string | undefined =
  process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export const hasDatabase = baseDatabaseUrl !== undefined;

export const databaseSkipReason =
  'set TEST_DATABASE_URL (or DATABASE_URL) to run PostgreSQL integration tests';

export interface ProvisionedDatabase {
  readonly url: string;
  readonly name: string;
  readonly shared: boolean;
  readonly migrations: MigrationReport;
  drop(): Promise<void>;
}

const adminUrlFor = (url: string): string => {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replace(/"/gu,'""')}"`;

const withClient = async <T>(url: string,operation: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({connectionString:url,application_name:'rebuplica-27-tests'});
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
};

const TRUNCATE_TABLES = ['audit_log','refresh_tokens','game_events','game_saves','games','users'] as const;

export const truncateAll = async (url: string): Promise<void> => {
  await withClient(url,async client => {
    await client.query(`TRUNCATE ${TRUNCATE_TABLES.map(quoteIdentifier).join(', ')} CASCADE`);
  });
};

export const provisionDatabase = async (label: string): Promise<ProvisionedDatabase> => {
  if (baseDatabaseUrl === undefined) throw new Error(databaseSkipReason);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu,'_').replace(/^_+|_+$/gu,'').slice(0,24) || 'test';
  const name = `rebuplica_test_${slug}_${randomBytes(4).toString('hex')}`;
  let url = baseDatabaseUrl;
  let shared = true;
  try {
    await withClient(adminUrlFor(baseDatabaseUrl),async client => {
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    });
    const parsed = new URL(baseDatabaseUrl);
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    shared = false;
  } catch {
    // No CREATEDB permission: run inside the configured database instead.
    url = baseDatabaseUrl;
  }
  // Migrations first: the shared fallback can only be truncated once the schema exists.
  const migrations = await applyMigrations({connectionString:url,ssl:'disable'});
  if (shared) await truncateAll(url);
  return {
    url,
    name,
    shared,
    migrations,
    drop: async () => {
      if (shared) {
        await truncateAll(url);
        return;
      }
      await withClient(adminUrlFor(baseDatabaseUrl),async client => {
        await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',[name]);
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      });
    },
  };
};

/** Persistence options tuned for tests: small pool, short timeouts. */
export const persistenceOptionsFor = (url: string): PostgresPersistenceOptions => ({
  connectionString:url,
  ssl:'disable',
  poolMax:5,
  connectionTimeoutMs:5_000,
  idleTimeoutMs:5_000,
  statementTimeoutMs:10_000,
});
