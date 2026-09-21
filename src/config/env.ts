import { randomBytes } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { ConfigError,type ConfigIssue } from './errors.ts';
import { Secret } from './secret.ts';

export const ENV_VAR_NAMES = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_SSL',
  'JWT_SECRET',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'ACCESS_TOKEN_TTL_SECONDS',
  'CORS_ALLOWED_ORIGINS',
] as const;

export type EnvVarName = (typeof ENV_VAR_NAMES)[number];
export type EnvSource = Readonly<Record<string, string | undefined>>;

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
const DATABASE_SSL_MODES = ['disable', 'require', 'no-verify'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

/** Values that must never be used as a production JWT secret. */
const REJECTED_PRODUCTION_SECRETS: readonly string[] = Object.freeze([
  'replace-with-a-random-secret-at-least-32-characters',
  'change-me',
  'changeme',
  'secret',
  'jwt-secret',
  'your-secret-here',
]);

const MINIMUM_JWT_SECRET_LENGTH = 32;
const MINIMUM_JWT_SECRET_ALPHABET = 8;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
const MINIMUM_ACCESS_TOKEN_TTL_SECONDS = 60;
const MAXIMUM_ACCESS_TOKEN_TTL_SECONDS = 86_400;

export interface AppConfig {
  readonly env: NodeEnv;
  readonly server: { readonly host: string; readonly port: number };
  readonly logLevel: LogLevel;
  readonly database: {
    readonly url: Secret<string>;
    readonly ssl: DatabaseSslMode;
    readonly poolMax: number;
    readonly connectionTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly statementTimeoutMs: number;
  };
  readonly auth: {
    readonly jwtSecret: Secret<string>;
    readonly jwtIssuer: string;
    readonly jwtAudience: string;
    readonly accessTokenTtlSeconds: number;
  };
  readonly http: { readonly corsAllowedOrigins: readonly string[] };
}

const DEFAULTS = {
  env: 'development',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'info',
  databaseSsl: 'disable',
  poolMax: 10,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 10_000,
  accessTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
} as const;

function read(env: EnvSource,name: EnvVarName): string | undefined {
  if (!Object.hasOwn(env,name)) return undefined;
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

function readChoice<T extends string>(
  env: EnvSource,
  name: EnvVarName,
  allowed: readonly T[],
  fallback: T,
  issues: ConfigIssue[],
): T {
  const raw = read(env,name);
  if (raw === undefined) return fallback;
  const match = allowed.find(candidate => candidate === raw);
  if (match === undefined) {
    issues.push({variable:name,message:`must be one of: ${allowed.join(', ')} (received "${raw}")`});
    return fallback;
  }
  return match;
}

function readInteger(
  env: EnvSource,
  name: EnvVarName,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: ConfigIssue[],
): number {
  const raw = read(env,name);
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push({variable:name,message:`must be an integer between ${minimum} and ${maximum} (received "${raw}")`});
    return fallback;
  }
  return value;
}

function readPort(env: EnvSource,name: EnvVarName,fallback: number,issues: ConfigIssue[]): number {
  return readInteger(env,name,fallback,1,65_535,issues);
}

function readHost(env: EnvSource,name: EnvVarName,fallback: string,issues: ConfigIssue[]): string {
  const raw = read(env,name);
  if (raw === undefined) return fallback;
  if (!isIPv6(raw) && !/^[A-Za-z0-9._-]+$/.test(raw)) {
    issues.push({variable:name,message:`must be a bare host name or IP address, without scheme, port or path (received "${raw}")`});
    return fallback;
  }
  return raw;
}

function readSecret(env: EnvSource,name: EnvVarName,issues: ConfigIssue[],minimumLength: number): Secret<string> | undefined {
  const raw = read(env,name);
  if (raw === undefined) {
    issues.push({variable:name,message:'is required'});
    return undefined;
  }
  if (raw.length < minimumLength) {
    issues.push({variable:name,message:`must contain at least ${minimumLength} characters (value hidden because it is a secret)`});
    return undefined;
  }
  return new Secret(raw);
}

function readPostgresUrl(env: EnvSource,name: EnvVarName,issues: ConfigIssue[]): Secret<string> | undefined {
  const raw = read(env,name);
  if (raw === undefined) {
    issues.push({variable:name,message:'is required'});
    return undefined;
  }
  const invalid = (reason: string): undefined => {
    issues.push({variable:name,message:`${reason} (value hidden because it is a secret)`});
    return undefined;
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid('must be a valid PostgreSQL URL: postgres://user:password@host:port/database');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return invalid('must use the postgres:// or postgresql:// scheme');
  if (url.hostname === '') return invalid('must include a host');
  if (url.pathname.length <= 1) return invalid('must include a database name');
  return new Secret(raw);
}

/** Production must not run with a documented placeholder secret or an obviously low-entropy value. */
function jwtSecretIssues(raw: string): string | undefined {
  if (REJECTED_PRODUCTION_SECRETS.includes(raw.toLowerCase())) return 'must not use the documented placeholder value in production';
  if (new Set(raw).size < MINIMUM_JWT_SECRET_ALPHABET) return 'must not be a low-entropy value in production';
  return undefined;
}

function readJwtSecret(env: EnvSource,nodeEnv: NodeEnv,issues: ConfigIssue[]): Secret<string> | undefined {
  const raw = read(env,'JWT_SECRET');
  if (raw === undefined) {
    if (nodeEnv === 'production') {
      issues.push({variable:'JWT_SECRET',message:'is required in production'});
      return undefined;
    }
    // Development and test generate an ephemeral secret so tokens cannot outlive a restart by accident.
    return new Secret(randomBytes(32).toString('base64url'));
  }
  const secret = readSecret(env,'JWT_SECRET',issues,MINIMUM_JWT_SECRET_LENGTH);
  if (secret === undefined) return undefined;
  if (nodeEnv === 'production') {
    const problem = jwtSecretIssues(raw);
    if (problem !== undefined) {
      issues.push({variable:'JWT_SECRET',message:`${problem} (value hidden because it is a secret)`});
      return undefined;
    }
  }
  return secret;
}

function readCorsOrigins(env: EnvSource,name: EnvVarName,issues: ConfigIssue[]): readonly string[] {
  const raw = read(env,name);
  if (raw === undefined) return Object.freeze([]);
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    const candidate = entry.trim();
    if (candidate === '') continue;
    if (candidate === '*') {
      issues.push({variable:name,message:'must list explicit origins; the wildcard "*" is not allowed for an authenticated API'});
      continue;
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      issues.push({variable:name,message:`must be a comma separated list of origins such as https://app.example.com (invalid entry "${candidate}")`});
      continue;
    }
    const origin = url.origin;
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || origin !== candidate.replace(/\/$/u,'')) {
      issues.push({variable:name,message:`entries must be bare origins without path or trailing slash (received "${candidate}")`});
      continue;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return Object.freeze(origins);
}

export function loadConfig(env: EnvSource): AppConfig {
  const issues: ConfigIssue[] = [];
  const nodeEnv = readChoice(env,'NODE_ENV',NODE_ENVS,DEFAULTS.env,issues);
  const host = readHost(env,'HOST',DEFAULTS.host,issues);
  const port = readPort(env,'PORT',DEFAULTS.port,issues);
  const logLevel = readChoice(env,'LOG_LEVEL',LOG_LEVELS,DEFAULTS.logLevel,issues);
  const databaseUrl = readPostgresUrl(env,'DATABASE_URL',issues);
  const databaseSsl = readChoice(env,'DATABASE_SSL',DATABASE_SSL_MODES,DEFAULTS.databaseSsl,issues);
  const jwtSecret = readJwtSecret(env,nodeEnv,issues);
  const accessTokenTtlSeconds = readInteger(
    env,
    'ACCESS_TOKEN_TTL_SECONDS',
    DEFAULTS.accessTokenTtlSeconds,
    MINIMUM_ACCESS_TOKEN_TTL_SECONDS,
    MAXIMUM_ACCESS_TOKEN_TTL_SECONDS,
    issues,
  );
  const corsAllowedOrigins = readCorsOrigins(env,'CORS_ALLOWED_ORIGINS',issues);
  const jwtIssuer = read(env,'JWT_ISSUER') ?? 'rebuplica-27';
  const jwtAudience = read(env,'JWT_AUDIENCE') ?? 'rebuplica-api';

  if (issues.length > 0 || databaseUrl === undefined || jwtSecret === undefined) throw new ConfigError(issues);

  return Object.freeze({
    env: nodeEnv,
    server: Object.freeze({host,port}),
    logLevel,
    database: Object.freeze({
      url: databaseUrl,
      ssl: databaseSsl,
      poolMax: DEFAULTS.poolMax,
      connectionTimeoutMs: DEFAULTS.connectionTimeoutMs,
      idleTimeoutMs: DEFAULTS.idleTimeoutMs,
      statementTimeoutMs: DEFAULTS.statementTimeoutMs,
    }),
    auth: Object.freeze({jwtSecret,jwtIssuer,jwtAudience,accessTokenTtlSeconds}),
    http: Object.freeze({corsAllowedOrigins}),
  });
}
