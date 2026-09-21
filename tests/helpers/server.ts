import { createServer } from 'node:net';
import { createApiServer,type ApiServer } from '../../src/api/server.ts';
import { createSilentLogger } from '../../src/api/logging.ts';
import { createInMemoryPersistence } from '../../src/persistence/in-memory.ts';
import type { Persistence } from '../../src/persistence/ports.ts';
import type { RateLimitPolicy } from '../../src/api/rate-limit.ts';

export const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';

export interface TestServerOptions {
  readonly persistence?: Persistence | undefined;
  readonly corsAllowedOrigins?: readonly string[] | undefined;
  readonly trustedProxyHops?: number | undefined;
  readonly rateLimits?: RateLimitPolicy | undefined;
  readonly bodyLimitBytes?: number | undefined;
  readonly accessTokenTtlSeconds?: number | undefined;
}

export interface TestServer {
  readonly url: string;
  readonly api: ApiServer;
  readonly persistence: Persistence;
  close(): Promise<void>;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export const startTestServer = async (options: TestServerOptions = {}): Promise<TestServer> => {
  const persistence = options.persistence ?? createInMemoryPersistence();
  const api = createApiServer({
    host:'127.0.0.1',
    port:0,
    logLevel:'silent',
    persistence,
    auth:{
      jwtSecret:TEST_JWT_SECRET,
      jwtIssuer:'rebuplica-27',
      jwtAudience:'rebuplica-api',
      accessTokenTtlSeconds:options.accessTokenTtlSeconds ?? 900,
      clockSkewSeconds:0,
    },
    corsAllowedOrigins:options.corsAllowedOrigins ?? [],
    trustedProxyHops:options.trustedProxyHops ?? 0,
    rateLimits:options.rateLimits,
    bodyLimitBytes:options.bodyLimitBytes,
    logger:createSilentLogger(),
  });
  const { port } = await api.listen();
  return {
    url:`http://127.0.0.1:${port}`,
    api,
    persistence,
    close: async () => { await api.close({timeoutMs:1_000}); },
  };
};

export interface RequestOptions {
  readonly method?: string;
  readonly token?: string | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string,string>> | undefined;
  readonly origin?: string | undefined;
  readonly rawBody?: string | undefined;
}

export const request = async (server: TestServer,path: string,options: RequestOptions = {}): Promise<TestResponse> => {
  const method = options.method ?? (options.body === undefined && options.rawBody === undefined ? 'GET' : 'POST');
  const headers: Record<string,string> = {...options.headers};
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers['origin'] = options.origin;
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['content-type'] ??= 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${server.url}${path}`,{
    method,
    headers,
    ...(body === undefined ? {} : {body}),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = {raw:text};
    }
  }
  return {status:response.status,headers:response.headers,body:parsed as Record<string, unknown>};
};

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

let userCounter = 0;

export const registerUser = async (
  server: TestServer,
  overrides: {readonly email?: string; readonly password?: string} = {},
): Promise<AuthenticatedUser> => {
  userCounter += 1;
  const email = overrides.email ?? `player-${userCounter}-${Date.now().toString(36)}@example.com`;
  const password = overrides.password ?? 'a-very-strong-password';
  const registered = await request(server,'/auth/register',{body:{email,password}});
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status} ${JSON.stringify(registered.body)}`);
  const user = registered.body['user'] as {id: string};
  const login = await request(server,'/auth/login',{body:{email,password}});
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return {id:user.id,email,token:login.body['accessToken'] as string};
};

export const createGame = async (server: TestServer,token: string,seed?: number): Promise<Record<string, unknown>> => {
  const created = await request(server,'/games',{token,body:seed === undefined ? {} : {seed}});
  if (created.status !== 201) throw new Error(`create game failed: ${created.status} ${JSON.stringify(created.body)}`);
  return created.body['game'] as Record<string, unknown>;
};

/** Reserves a free local port (used by tests that spawn the real process). */
export const freePort = async (): Promise<number> => new Promise<number>((resolve,reject) => {
  const probe = createServer();
  probe.once('error',reject);
  probe.listen(0,'127.0.0.1',() => {
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    probe.close(() => { resolve(port); });
  });
});
