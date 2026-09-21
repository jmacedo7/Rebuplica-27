/**
 * Migration CLI: `npm run migrate` applies pending migrations, `npm run migrate:status`
 * prints the state without touching the database.
 */
import { ConfigError,loadConfig } from '../src/config/index.ts';
import { applyMigrations,migrationStatus,MIGRATIONS_DIRECTORY } from '../src/persistence/migrations.ts';

const command = process.argv[2] ?? 'up';

const main = async (): Promise<void> => {
  const config = loadConfig(process.env);
  const options = {
    connectionString: config.database.url.reveal(),
    ssl: config.database.ssl,
    directory: MIGRATIONS_DIRECTORY,
    onLog: (message: string): void => { console.log(message); },
  };
  if (command === 'up') {
    const report = await applyMigrations(options);
    console.log(JSON.stringify({applied: report.applied, alreadyApplied: report.skipped},null,2));
    return;
  }
  if (command === 'status') {
    const entries = await migrationStatus(options);
    console.table(entries.map(entry => ({
      version: entry.version,
      name: entry.name,
      applied: entry.applied,
      appliedAt: entry.appliedAt ?? '-',
      checksum: entry.checksumMatches ? 'ok' : 'CHANGED',
    })));
    if (entries.some(entry => !entry.checksumMatches)) process.exitCode = 1;
    return;
  }
  console.error(`Unknown command "${command}". Use "up" or "status".`);
  process.exitCode = 1;
};

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
