import { createServer,type IncomingMessage,type Server,type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthService,type Principal } from './auth-service.ts';
import {
  ApiError,
  forbidden,
  mapError,
  notFound,
  unauthorized,
  validationError,
} from './errors.ts';
import { GameService } from './game-service.ts';
import {
  DEFAULT_MAXIMUM_BODY_BYTES,
  applySecurityHeaders,
  json,
  parseJson,
  readBearerToken,
  readCookie,
  resolveClientAddress,
  resolveCors,
  resolveRequestId,
  sessionCookie,
  type ResponseHeaders,
} from './http.ts';
import { createLogger,type Logger } from './logging.ts';
import {
  DEFAULT_RATE_LIMITS,
  createRateLimiterSet,
  type RateLimitPolicy,
  type RateLimitScope,
} from './rate-limit.ts';
import { GeminiService } from '../ai/gemini.ts';
import { Router } from './router.ts';
import {
  parseAfterVersion,
  parsePagination,
  rejectUnknownKeys,
  requireString,
  requireUuid,
  validateDecisionInput,
} from './validation.ts';
import type { LogLevel,Secret } from '../config/index.ts';
import type { Persistence } from '../persistence/ports.ts';
import type { GeminiFetcher } from '../ai/gemini.ts';

const SERVICE_NAME = 'rebuplica-27';
const SESSION_COOKIE = 'session_token';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAXIMUM_SEED = 4_294_967_295;

export interface ApiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly persistence: Persistence;
  readonly auth: {
    readonly jwtSecret: string;
    readonly jwtIssuer: string;
    readonly jwtAudience: string;
    readonly accessTokenTtlSeconds: number;
    readonly clockSkewSeconds?: number | undefined;
    readonly sessionTtlSeconds?: number | undefined;
  };
  readonly ai: {
    /** Absent key = integration pending configuration (endpoint answers AI_NOT_CONFIGURED). */
    readonly apiKey?: Secret<string> | undefined;
    readonly model: string;
    readonly timeoutMs: number;
    /** Injectable so tests never call the real provider. */
    readonly fetcher?: GeminiFetcher | undefined;
  };
  readonly corsAllowedOrigins: readonly string[];
  readonly trustedProxyHops?: number | undefined;
  readonly rateLimits?: RateLimitPolicy | undefined;
  readonly bodyLimitBytes?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface ApiServer {
  readonly server: Server;
  readonly logger: Logger;
  readonly auth: AuthService;
  readonly games: GameService;
  readonly ai: GeminiService;
  listen(): Promise<{host: string; port: number}>;
  /** Stops accepting connections, drains in-flight requests and hard-closes after the timeout. */
  close(options?: {readonly timeoutMs?: number | undefined}): Promise<void>;
}

interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: ResponseHeaders | undefined;
}

interface RouteContext {
  readonly params: Readonly<Record<string,string>>;
  readonly searchParams: URLSearchParams;
  readonly requestId: string;
  readonly logger: Logger;
  readonly principal: Principal | null;
  readonly auth: AuthService;
  readonly games: GameService;
  readonly ai: GeminiService;
  readonly persistence: Persistence;
  readonly uptimeSeconds: number;
  /** Opaque browser session token presented by the caller (cookie or bearer). */
  readonly sessionToken: string | null;
  readBody(): Promise<Record<string,unknown>>;
}

interface RouteDefinition {
  readonly method: 'GET' | 'POST';
  readonly pattern: string;
  readonly auth: boolean;
  readonly handler: (context: RouteContext) => Promise<RouteResponse>;
}

const requirePrincipal = (context: RouteContext): Principal => {
  if (context.principal === null) throw unauthorized();
  return context.principal;
};

const pageEnvelope = (page: {total: number; limit: number; offset: number}): {limit: number; offset: number; total: number} =>
  ({limit:page.limit,offset:page.offset,total:page.total});

const routes: readonly RouteDefinition[] = [
  {
    method:'GET',
    pattern:'/health',
    auth:false,
    handler: async context => ({
      status:200,
      body:{status:'ok',service:SERVICE_NAME,uptimeSeconds:context.uptimeSeconds},
    }),
  },
  {
    method:'GET',
    pattern:'/ready',
    auth:false,
    handler: async context => {
      try {
        await context.persistence.ping();
      } catch {
        return {status:503,body:{status:'not-ready',service:SERVICE_NAME,checks:{database:'unavailable'}}};
      }
      return {status:200,body:{status:'ready',service:SERVICE_NAME,checks:{database:'ok'}}};
    },
  },
  {
    method:'POST',
    pattern:'/auth/register',
    auth:false,
    handler: async context => {
      const body = await context.readBody();
      rejectUnknownKeys(body,['email','password','displayName']);
      const email = body['email'];
      const password = body['password'];
      if (typeof email !== 'string') throw validationError('email is required');
      if (typeof password !== 'string') throw validationError('password is required');
      const displayName = body['displayName'];
      if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
        throw validationError('displayName must be a string');
      }
      const user = await context.auth.register(email,password,typeof displayName === 'string' ? displayName : undefined);
      return {status:201,body:{user}};
    },
  },
  {
    method:'POST',
    pattern:'/auth/login',
    auth:false,
    handler: async context => {
      const body = await context.readBody();
      rejectUnknownKeys(body,['email','password']);
      const email = body['email'];
      const password = body['password'];
      if (typeof email !== 'string') throw validationError('email is required');
      if (typeof password !== 'string') throw validationError('password is required');
      const result = await context.auth.login(email,password);
      return {
        status:200,
        body:{accessToken:result.accessToken,tokenType:'Bearer',expiresIn:result.expiresIn,expiresAt:result.expiresAt,user:result.principal},
        headers:{'set-cookie':sessionCookie(SESSION_COOKIE,result.sessionToken,result.maxAgeSeconds)},
      };
    },
  },
  {
    method:'POST',
    pattern:'/auth/logout',
    auth:false,
    handler: async context => {
      if (context.sessionToken !== null) await context.auth.revokeSession(context.sessionToken);
      return {
        status:200,
        body:{ok:true},
        headers:{'set-cookie':sessionCookie(SESSION_COOKIE,'',0)},
      };
    },
  },
  {
    method:'GET',
    pattern:'/auth/me',
    auth:true,
    handler: async context => ({status:200,body:{user:requirePrincipal(context)}}),
  },
  {
    method:'POST',
    pattern:'/games',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const body = await context.readBody();
      rejectUnknownKeys(body,['seed']);
      const seed = body['seed'];
      if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAXIMUM_SEED)) {
        throw validationError(`seed must be an integer between 0 and ${MAXIMUM_SEED}`);
      }
      const game = await context.games.create(principal.id,{seed});
      return {status:201,body:{game}};
    },
  },
  {
    method:'GET',
    pattern:'/games',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const page = await context.games.list(principal.id,parsePagination(context.searchParams));
      return {status:200,body:{games:page.items,page:pageEnvelope(page)}};
    },
  },
  {
    method:'GET',
    pattern:'/games/:gameId',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const game = await context.games.get(principal.id,requireUuid(context.params['gameId'],'gameId'));
      return {status:200,body:{game}};
    },
  },
  {
    method:'POST',
    pattern:'/games/:gameId/decisions',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const gameId = requireUuid(context.params['gameId'],'gameId');
      const body = await context.readBody();
      const game = await context.games.applyDecision(principal.id,gameId,validateDecisionInput(body,context.games.decisionTypes));
      return {status:200,body:{game}};
    },
  },
  {
    method:'POST',
    pattern:'/games/:gameId/turn',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const gameId = requireUuid(context.params['gameId'],'gameId');
      const body = await context.readBody();
      rejectUnknownKeys(body,['days']);
      const days = body['days'];
      if (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
        throw validationError('days must be an integer between 1 and 3650');
      }
      const game = await context.games.advanceTurn(principal.id,gameId,days);
      return {status:200,body:{game}};
    },
  },
  {
    method:'GET',
    pattern:'/games/:gameId/events',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const page = await context.games.listEvents(
        principal.id,
        requireUuid(context.params['gameId'],'gameId'),
        {...parsePagination(context.searchParams,{defaultLimit:50,maxLimit:200}),afterVersion:parseAfterVersion(context.searchParams)},
      );
      return {status:200,body:{events:page.items,page:pageEnvelope(page)}};
    },
  },
  {
    method:'GET',
    pattern:'/games/:gameId/replay',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const replay = await context.games.replay(principal.id,requireUuid(context.params['gameId'],'gameId'));
      return {status:200,body:{replay}};
    },
  },
  {
    method:'POST',
    pattern:'/ai/ping',
    auth:true,
    handler: async context => {
      requirePrincipal(context);
      const body = await context.readBody();
      rejectUnknownKeys(body,['prompt']);
      const prompt = requireString(body,'prompt',{minLength:3,maxLength:1_000});
      const result = await context.ai.generate(prompt);
      return {status:200,body:{reply:result.text,model:result.model}};
    },
  },
  {
    method:'POST',
    pattern:'/games/:gameId/saves',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const save = await context.games.createSave(principal.id,requireUuid(context.params['gameId'],'gameId'));
      return {status:201,body:{save}};
    },
  },
  {
    method:'GET',
    pattern:'/games/:gameId/saves',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const page = await context.games.listSaves(
        principal.id,
        requireUuid(context.params['gameId'],'gameId'),
        parsePagination(context.searchParams),
      );
      return {status:200,body:{saves:page.items,page:pageEnvelope(page)}};
    },
  },
  {
    method:'POST',
    pattern:'/games/:gameId/saves/:saveId/restore',
    auth:true,
    handler: async context => {
      const principal = requirePrincipal(context);
      const result = await context.games.restoreSave(
        principal.id,
        requireUuid(context.params['gameId'],'gameId'),
        requireUuid(context.params['saveId'],'saveId'),
      );
      return {status:200,body:{game:result.game,save:{id:result.saveId,version:result.restoredFromVersion}}};
    },
  },
];

const router = new Router(routes.map(route => ({method:route.method,pattern:route.pattern})));

const rateScopeFor = (method: string,pathname: string): RateLimitScope | null => {
  if (pathname === '/health' || pathname === '/ready') return null;
  // Session introspection is a read: the page does it on every load.
  if (pathname === '/auth/me') return 'read';
  if (pathname === '/ai/ping') return 'ai';
  if (pathname.startsWith('/auth/')) return 'auth';
  return method === 'GET' ? 'read' : 'write';
};

const isStateChanging = (method: string | undefined): boolean =>
  method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

const firstHeaderValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Resolve the externally visible origin when the request reaches us through a TLS proxy. */
const resolveRequestOrigin = (request: IncomingMessage): string | undefined => {
  const host = request.headers.host;
  if (host === undefined || host.trim() === '') return undefined;
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])
    ?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProto ?? 'http';
  if (protocol !== 'http' && protocol !== 'https') return undefined;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
};


export const createApiServer = (options: ApiServerOptions): ApiServer => {
  const logger = options.logger ?? createLogger({level:options.logLevel,context:{service:SERVICE_NAME}});
  const auth = new AuthService(options.persistence,{
    jwtSecret:options.auth.jwtSecret,
    jwtIssuer:options.auth.jwtIssuer,
    jwtAudience:options.auth.jwtAudience,
    accessTokenTtlSeconds:options.auth.accessTokenTtlSeconds,
    clockSkewSeconds:options.auth.clockSkewSeconds,
    sessionTtlSeconds:options.auth.sessionTtlSeconds,
  });
  const games = new GameService(options.persistence);
  const ai = new GeminiService({
    apiKey:options.ai.apiKey,
    model:options.ai.model,
    timeoutMs:options.ai.timeoutMs,
    fetcher:options.ai.fetcher,
  });
  const limiters = createRateLimiterSet(options.rateLimits ?? DEFAULT_RATE_LIMITS);
  const allowedOrigins = options.corsAllowedOrigins;
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_MAXIMUM_BODY_BYTES;
  const trustedProxyHops = options.trustedProxyHops ?? 0;
  const startedAtMs = Date.now();

  const handle = async (request: IncomingMessage,response: ServerResponse): Promise<void> => {
    const requestId = resolveRequestId(request);
    const startedAt = performance.now();
    const method = request.method ?? 'GET';
    const origin = request.headers.origin;
    let pathname = request.url?.split('?')[0] ?? '/';
    const cors = resolveCors(
      typeof origin === 'string' ? origin : undefined,
      allowedOrigins,
      resolveRequestOrigin(request),
    );
    let routePattern = pathname;
    let principalId: string | null = null;

    applySecurityHeaders(response);
    response.setHeader('x-request-id',requestId);
    for (const [name,value] of Object.entries(cors.headers)) response.setHeader(name,value);

    const finish = (status: number): void => {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const fields = {
        requestId,
        method,
        route:routePattern,
        path:pathname,
        status,
        durationMs,
        userId:principalId,
        origin:typeof origin === 'string' ? origin : undefined,
      };
      if (status >= 500) logger.error('request failed',fields);
      else if (status >= 400) logger.warn('request rejected',fields);
      else logger.info('request completed',fields);
    };

    try {
      let url: URL;
      try {
        url = new URL(request.url ?? '/',`http://${request.headers.host ?? 'localhost'}`);
      } catch {
        throw new ApiError(400,'VALIDATION_ERROR','Malformed request URL');
      }
      pathname = url.pathname;
      // Strip the /api prefix added by the ingress proxy so internal route
      // patterns stay stable (health/auth/games/etc. mounted at root).
      if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
      else if (pathname === '/api') pathname = '/';

      if (method === 'OPTIONS') {
        if (!cors.allowed) throw forbidden('Origin not allowed');
        response.statusCode = 204;
        response.end();
        finish(204);
        return;
      }
      // Browser requests from an unlisted origin are rejected outright. Requests without
      // an Origin header (server to server, CLI, tests) still need a valid token.
      if (isStateChanging(method) && origin !== undefined && !cors.allowed) throw forbidden('Origin not allowed');

      const scope = rateScopeFor(method,pathname);
      if (scope !== null) {
        const decision = limiters.check(scope,resolveClientAddress(request,trustedProxyHops));
        response.setHeader('x-ratelimit-limit',String(limiters.limiters[scope].rule.limit));
        response.setHeader('x-ratelimit-remaining',String(decision.remaining));
        if (!decision.allowed) {
          response.setHeader('retry-after',String(decision.retryAfterSeconds));
          throw new ApiError(429,'RATE_LIMITED','Too many requests');
        }
      }

      const match = router.match(method,pathname);
      if (match === null) {
        const allowed = router.allowedMethods(pathname);
        if (allowed.length > 0) {
          response.setHeader('allow',allowed.join(', '));
          throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed');
        }
        throw notFound();
      }
      routePattern = match.pattern;
      const route = routes.find(candidate => candidate.method === method && candidate.pattern === match.pattern);
      if (route === undefined) throw notFound();

      let principal: Principal | null = null;
      const cookieSession = readCookie(request,SESSION_COOKIE);
      const bearer = readBearerToken(request);
      if (route.auth) {
        if (cookieSession !== null) {
          principal = await auth.authenticateSession(cookieSession);
        } else if (bearer !== null) {
          // A bearer can be either a JWT access token or an opaque session token.
          try {
            principal = await auth.authenticate(bearer);
          } catch {
            principal = await auth.authenticateSession(bearer);
          }
        } else {
          throw unauthorized();
        }
        principalId = principal.id;
      }

      const context: RouteContext = {
        params:match.params,
        searchParams:url.searchParams,
        requestId,
        logger:logger.child({requestId,route:routePattern}),
        principal,
        auth,
        games,
        ai,
        persistence:options.persistence,
        uptimeSeconds:Math.round((Date.now() - startedAtMs) / 1000),
        sessionToken:cookieSession ?? bearer,
        readBody: () => parseJson(request,{maxBytes:bodyLimitBytes}),
      };
      const result = await route.handler(context);
      json(response,result.status,result.body,result.headers ?? {});
      finish(result.status);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.unexpected) logger.error('unhandled error',{requestId,method,path:pathname,error});
      json(response,mapped.status,{
        error:{
          code:mapped.code,
          message:mapped.message,
          ...(mapped.details === undefined ? {} : {details:mapped.details}),
        },
        requestId,
      });
      finish(mapped.status);
    }
  };

  const server = createServer((request,response) => {
    void handle(request,response).catch((error: unknown) => {
      logger.error('request handler crashed',{error});
      if (!response.headersSent) json(response,500,{error:{code:'INTERNAL_ERROR',message:'Internal server error'}});
      else response.end();
    });
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  const close = (closeOptions: {readonly timeoutMs?: number | undefined} = {}): Promise<void> => {
    const timeoutMs = closeOptions.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    return new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => {
        logger.warn('forcing connection close after shutdown timeout',{timeoutMs});
        server.closeAllConnections();
      },timeoutMs);
      timer.unref();
      server.close(error => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
  };

  return {
    server,
    logger,
    auth,
    games,
    ai,
    listen: () => new Promise((resolve,reject) => {
      server.once('error',reject);
      server.listen(options.port,options.host,() => {
        const address = server.address() as AddressInfo | null;
        resolve({host:address?.address ?? options.host,port:address?.port ?? options.port});
      });
    }),
    close,
  };
};
