import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';

/**
 * Access tokens: HMAC-SHA256 JWTs.
 *
 * Security properties enforced here:
 *  - the header is never trusted: `alg` must be exactly HS256, so `alg: none` and
 *    algorithm substitution attacks are rejected before any signature work;
 *  - the signature is compared with a constant time equality check;
 *  - issuer, audience, issuer time (`iat`), expiration (`exp`), optional `not before`
 *    and `jti` are validated, with a configurable clock skew allowance;
 *  - every base64url segment and claim type is validated, so a token that merely
 *    "looks like" a JWT is never accepted.
 */
export const JWT_ALGORITHM = 'HS256';
export const MAXIMUM_TOKEN_LENGTH = 4096;
export const DEFAULT_TOKEN_TTL_SECONDS = 900;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const SIGNATURE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAXIMUM_SUBJECT_LENGTH = 128;
const MAXIMUM_TTL_SECONDS = 86_400;

export interface AccessClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export class InvalidTokenError extends Error {
  constructor(message = 'Invalid access token') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

const sign = (input: string,secret: string): Buffer => createHmac('sha256',secret).update(input).digest();

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

export interface IssueTokenOptions {
  readonly ttlSeconds?: number | undefined;
  readonly nowSeconds?: number | undefined;
}

export const issueAccessToken = (
  subject: string,
  secret: string,
  issuer: string,
  audience: string,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
  nowSeconds = nowInSeconds(),
): string => {
  if (subject.trim() === '') throw new Error('Token subject is required');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAXIMUM_TTL_SECONDS) {
    throw new Error(`Token lifetime must be an integer between 1 and ${MAXIMUM_TTL_SECONDS} seconds`);
  }
  if (!Number.isInteger(nowSeconds)) throw new Error('Token issue time must be an integer');
  const header = base64url(JSON.stringify({alg:JWT_ALGORITHM,typ:'JWT'}));
  const payload = base64url(JSON.stringify({
    sub:subject,
    iss:issuer,
    aud:audience,
    iat:nowSeconds,
    exp:nowSeconds + ttlSeconds,
    jti:randomBytes(16).toString('hex'),
  }));
  return `${header}.${payload}.${base64url(sign(`${header}.${payload}`,secret))}`;
};

export interface VerifyTokenOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds?: number | undefined;
  readonly clockSkewSeconds?: number | undefined;
}

const decodeSegment = (segment: string): Buffer => {
  if (!BASE64URL_PATTERN.test(segment)) throw new InvalidTokenError();
  return Buffer.from(segment,'base64url');
};

const readInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

export const verifyAccessTokenWithOptions = (token: string,options: VerifyTokenOptions): AccessClaims => {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) throw new InvalidTokenError();
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidTokenError();
  const [headerSegment,payloadSegment,signatureSegment] = parts;
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) throw new InvalidTokenError();

  const signature = decodeSegment(signatureSegment);
  if (signature.length !== SIGNATURE_BYTES) throw new InvalidTokenError();
  const expected = sign(`${headerSegment}.${payloadSegment}`,options.secret);
  if (expected.length !== signature.length || !timingSafeEqual(expected,signature)) throw new InvalidTokenError();

  const header = parseObject(decodeSegment(headerSegment));
  if (header['alg'] !== JWT_ALGORITHM) throw new InvalidTokenError();
  if (header['typ'] !== undefined && header['typ'] !== 'JWT') throw new InvalidTokenError();

  const claims = parseObject(decodeSegment(payloadSegment));
  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject.trim() === '' || subject.length > MAXIMUM_SUBJECT_LENGTH) throw new InvalidTokenError();
  if (claims['iss'] !== options.issuer) throw new InvalidTokenError();
  if (claims['aud'] !== options.audience) throw new InvalidTokenError();
  const issuedAt = readInteger(claims['iat']);
  const expiresAt = readInteger(claims['exp']);
  const tokenId = claims['jti'];
  if (issuedAt === undefined || expiresAt === undefined) throw new InvalidTokenError();
  if (typeof tokenId !== 'string' || tokenId.trim() === '' || tokenId.length > 128) throw new InvalidTokenError();
  if (expiresAt <= issuedAt) throw new InvalidTokenError();

  const now = options.nowSeconds ?? nowInSeconds();
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(now)) throw new InvalidTokenError();
  if (expiresAt <= now - skew) throw new InvalidTokenError();
  if (issuedAt > now + skew) throw new InvalidTokenError();
  const notBefore = claims['nbf'];
  if (notBefore !== undefined) {
    const parsedNotBefore = readInteger(notBefore);
    if (parsedNotBefore === undefined || parsedNotBefore > now + skew) throw new InvalidTokenError();
  }

  return {sub:subject,iss:options.issuer,aud:options.audience,iat:issuedAt,exp:expiresAt,jti:tokenId};
};

const parseObject = (buffer: Buffer): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new InvalidTokenError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvalidTokenError();
  return parsed as Record<string, unknown>;
};

/** Backwards compatible positional signature. */
export const verifyAccessToken = (
  token: string,
  secret: string,
  issuer: string,
  audience: string,
  nowSeconds?: number,
  clockSkewSeconds?: number,
): AccessClaims =>
  verifyAccessTokenWithOptions(token,{secret,issuer,audience,nowSeconds,clockSkewSeconds});
