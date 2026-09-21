import { createApiServer } from './api/server.ts';
import { createLogger } from './api/logging.ts';
import { ConfigError,loadConfig,type AppConfig } from './config/index.ts';
import { createPostgresPersistence,type PostgresPersistence } from './persistence/postgres.ts';

/**
 * Process entry point.
 *
 * Wiring is explicit: the runtime always builds the PostgreSQL persistence from
 * `DATABASE_URL`, there is no in-memory fallback, and the process refuses to start
 * when the configuration or the database is unusable.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const main = async (): Promise<void> => {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const logger = createLogger({
    level:config.logLevel,
    context:{service:'rebuplica-27',env:config.env},
  });

  const persistence: PostgresPersistence = createPostgresPersistence({
    connectionString:config.database.url.reveal(),
    ssl:config.database.ssl,
    poolMax:config.database.poolMax,
    connectionTimeoutMs:config.database.connectionTimeoutMs,
    idleTimeoutMs:config.database.idleTimeoutMs,
    statementTimeoutMs:config.database.statementTimeoutMs,
    onPoolError:error => { logger.error('database pool error',{error}); },
  });

  try {
    await persistence.ping();
  } catch (error) {
    logger.error('database is not reachable; aborting startup',{error});
    await persistence.close().catch(() => undefined);
    process.exitCode = 69; // EX_UNAVAILABLE
    return;
  }

  const api = createApiServer({
    host:config.server.host,
    port:config.server.port,
    logLevel:config.logLevel,
    persistence,
    auth:{
      jwtSecret:config.auth.jwtSecret.reveal(),
      jwtIssuer:config.auth.jwtIssuer,
      jwtAudience:config.auth.jwtAudience,
      accessTokenTtlSeconds:config.auth.accessTokenTtlSeconds,
    },
    corsAllowedOrigins:config.http.corsAllowedOrigins,
    logger,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string,exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down',{signal});
    try {
      await api.close({timeoutMs:SHUTDOWN_TIMEOUT_MS});
      logger.info('http server closed');
    } catch (error) {
      logger.error('failed to close the http server',{error});
    }
    try {
      await persistence.close();
      logger.info('database pool closed');
    } catch (error) {
      logger.error('failed to close the database pool',{error});
    }
    process.exitCode = exitCode;
  };

  for (const signal of ['SIGINT','SIGTERM'] as const) {
    process.once(signal,() => { void shutdown(signal,0); });
  }
  process.on('unhandledRejection',reason => {
    logger.error('unhandled promise rejection',{error:reason});
  });
  process.on('uncaughtException',error => {
    logger.error('uncaught exception; shutting down',{error});
    void shutdown('uncaughtException',1);
  });

  const { host,port } = await api.listen();
  // Single structured line; external supervisors and tests wait for it.
  logger.info('api listening',{host,port});
};

await main();
