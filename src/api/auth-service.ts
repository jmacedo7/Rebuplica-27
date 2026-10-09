import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { Persistence,UserRecord } from '../persistence/ports.ts';
import { EmailConflictError } from '../persistence/errors.ts';
import { InvalidTokenError,hashPasswordAsync,issueAccessToken,verifyAccessTokenWithOptions,verifyPasswordAsync } from '../security/index.ts';
import { conflict,unauthorized } from './errors.ts';
import { fetchEmergentProfile,type OAuthProfileFetcher } from './oauth.ts';
import { validateEmail,validatePassword } from './validation.ts';

export interface Principal {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
  readonly displayName: string | null;
  readonly pictureUrl: string | null;
}

export interface SessionResult {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly maxAgeSeconds: number;
  readonly principal: Principal;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly principal: Principal;
}

export interface AuthServiceOptions {
  readonly jwtSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly accessTokenTtlSeconds: number;
  readonly clockSkewSeconds?: number | undefined;
  /** Injectable so tests never call the real Emergent auth service. */
  readonly oauthProfileFetcher?: OAuthProfileFetcher | undefined;
  readonly sessionTtlSeconds?: number | undefined;
}

const toPrincipal = (user: UserRecord): Principal => ({
  id:user.id,
  email:user.email,
  createdAt:user.createdAt,
  displayName:user.displayName,
  pictureUrl:user.pictureUrl,
});

export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Sessions are looked up by hash: the raw cookie value never reaches the database. */
const hashSessionToken = (token: string): string => createHash('sha256').update(token,'utf8').digest('hex');

/** Verified once, lazily, to keep failed logins as slow as successful ones. */
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = (): Promise<string> => {
  dummyHashPromise ??= hashPasswordAsync('dummy-password-used-only-for-timing-equalisation');
  return dummyHashPromise;
};

export class AuthService {
  readonly #persistence: Persistence;
  readonly #options: AuthServiceOptions;

  constructor(persistence: Persistence,options: AuthServiceOptions) {
    this.#persistence = persistence;
    this.#options = options;
  }

  async register(email: string,password: string): Promise<Principal> {
    const normalizedEmail = validateEmail(email);
    const passwordHash = await hashPasswordAsync(validatePassword(password));
    try {
      return await this.#persistence.transaction(async repositories => {
        const user = await repositories.users.create({id:randomUUID(),email:normalizedEmail,passwordHash});
        await repositories.audit.record({
          actorId:user.id,
          action:'auth.register',
          resourceType:'user',
          resourceId:user.id,
          metadata:{email:user.email},
        });
        return toPrincipal(user);
      });
    } catch (error) {
      if (error instanceof EmailConflictError) throw conflict('EMAIL_ALREADY_EXISTS','Email already exists');
      throw error;
    }
  }

  async login(email: string,password: string): Promise<LoginResult> {
    const normalizedEmail = validateEmail(email);
    const candidate = validatePassword(password);
    const user = await this.#persistence.users.findByEmail(normalizedEmail);
    if (user === null) {
      // Equalise timing so a missing account cannot be distinguished from a wrong password.
      await verifyPasswordAsync(candidate,await dummyHash());
      await this.#recordFailedLogin(null,normalizedEmail);
      throw unauthorized('Invalid credentials');
    }
    const valid = await verifyPasswordAsync(candidate,user.passwordHash);
    if (!valid) {
      await this.#recordFailedLogin(user.id,normalizedEmail);
      throw unauthorized('Invalid credentials');
    }
    const accessToken = this.#issue(user.id);
    await this.#persistence.transaction(async repositories => {
      await repositories.audit.record({
        actorId:user.id,
        action:'auth.login_succeeded',
        resourceType:'user',
        resourceId:user.id,
        metadata:{},
      });
    });
    return {accessToken,expiresIn:this.#options.accessTokenTtlSeconds,principal:toPrincipal(user)};
  }

  /** Resolves the caller from a bearer token, loading the current user record. */
  async authenticate(token: string): Promise<Principal> {
    let subject: string;
    try {
      subject = verifyAccessTokenWithOptions(token,{
        secret:this.#options.jwtSecret,
        issuer:this.#options.jwtIssuer,
        audience:this.#options.jwtAudience,
        clockSkewSeconds:this.#options.clockSkewSeconds,
      }).sub;
    } catch (error) {
      if (error instanceof InvalidTokenError) throw unauthorized();
      throw error;
    }
    const user = await this.#persistence.users.findById(subject);
    if (user === null) throw unauthorized();
    return toPrincipal(user);
  }

  /**
   * Exchanges the one-shot Emergent `session_id` for a browser session.
   * The account is created on first login and refreshed on every later login;
   * password login stays impossible for these accounts (random unusable hash).
   */
  async exchangeOAuthSession(sessionId: string): Promise<SessionResult> {
    const fetchProfile = this.#options.oauthProfileFetcher ?? fetchEmergentProfile;
    const profile = await fetchProfile(sessionId);
    const existing = await this.#persistence.users.findByEmail(profile.email);
    const ttlSeconds = this.#options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const unusablePasswordHash = existing === null
      ? await hashPasswordAsync(`oauth-only-${randomBytes(32).toString('hex')}`)
      : existing.passwordHash;

    return this.#persistence.transaction(async repositories => {
      const user = existing === null
        ? await repositories.users.create({
          id:randomUUID(),
          email:profile.email,
          passwordHash:unusablePasswordHash,
          displayName:profile.name,
          pictureUrl:profile.picture,
        })
        : await repositories.users.updateProfile(existing.id,{displayName:profile.name,pictureUrl:profile.picture});
      await repositories.sessions.create({
        id:randomUUID(),
        userId:user.id,
        tokenHash:hashSessionToken(profile.sessionToken),
        provider:'emergent-google',
        expiresAt,
      });
      await repositories.audit.record({
        actorId:user.id,
        action:existing === null ? 'auth.oauth_registered' : 'auth.oauth_login',
        resourceType:'user',
        resourceId:user.id,
        metadata:{email:user.email,provider:'emergent-google'},
      });
      return {
        sessionToken:profile.sessionToken,
        expiresAt,
        maxAgeSeconds:ttlSeconds,
        principal:toPrincipal(user),
      };
    });
  }

  /** Resolves the caller from an opaque session token (cookie or bearer). */
  async authenticateSession(sessionToken: string): Promise<Principal> {
    const session = await this.#persistence.sessions.findActiveByHash(hashSessionToken(sessionToken));
    if (session === null) throw unauthorized();
    const user = await this.#persistence.users.findById(session.userId);
    if (user === null) throw unauthorized();
    return toPrincipal(user);
  }

  async revokeSession(sessionToken: string): Promise<void> {
    await this.#persistence.sessions.revokeByHash(hashSessionToken(sessionToken));
  }

  #issue(userId: string): string {
    return issueAccessToken(userId,this.#options.jwtSecret,this.#options.jwtIssuer,this.#options.jwtAudience,this.#options.accessTokenTtlSeconds);
  }

  async #recordFailedLogin(actorId: string | null,email: string): Promise<void> {
    try {
      await this.#persistence.audit.record({
        actorId,
        action:'auth.login_failed',
        resourceType:'user',
        resourceId:actorId,
        metadata:{email},
      });
    } catch {
      // Auditing a failure must never change the authentication outcome.
    }
  }
}
