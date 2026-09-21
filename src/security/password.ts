import { randomBytes,scrypt,scryptSync,timingSafeEqual,type ScryptOptions } from 'node:crypto';

/**
 * Password hashing: scrypt with a per password random salt and parameters stored
 * inside the encoded hash, so parameters can be raised later without breaking old
 * hashes.
 *
 * Format: `scrypt$N=<n>,r=<r>,p=<p>$<salt base64url>$<derived key base64url>`
 * Legacy hashes without the parameter segment are still verified with the original
 * parameters, and `passwordNeedsRehash` reports them so callers can upgrade on login.
 */
const ALGORITHM = 'scrypt';
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 200;
export const DEFAULT_SCRYPT_PARAMETERS = Object.freeze({N:32_768,r:8,p:1,maxmem:64 * 1024 * 1024}) as Readonly<ScryptOptions> & {readonly N: number; readonly r: number; readonly p: number};
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export class WeakPasswordError extends Error {
  constructor(message = `Password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters`) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

const assertPasswordAcceptable = (password: string): void => {
  if (typeof password !== 'string') throw new WeakPasswordError('Password must be a string');
  if (password.length < MINIMUM_PASSWORD_LENGTH) throw new WeakPasswordError();
  if (password.length > MAXIMUM_PASSWORD_LENGTH) throw new WeakPasswordError(`Password must not exceed ${MAXIMUM_PASSWORD_LENGTH} characters`);
};

const encodeParameters = (parameters: ScryptOptions & {N: number; r: number; p: number}): string =>
  `N=${parameters.N},r=${parameters.r},p=${parameters.p}`;

interface ParsedHash {
  readonly parameters: ScryptOptions & {N: number; r: number; p: number};
  readonly salt: Buffer;
  readonly expected: Buffer;
}

const parseHash = (encoded: string): ParsedHash | null => {
  if (typeof encoded !== 'string' || encoded.length > 512) return null;
  const parts = encoded.split('$');
  const [algorithm, ...rest] = parts;
  if (algorithm !== ALGORITHM) return null;
  let parameters: ScryptOptions & {N: number; r: number; p: number} = {...DEFAULT_SCRYPT_PARAMETERS};
  let saltText: string | undefined;
  let hashText: string | undefined;
  if (rest.length === 3) {
    const [parameterText, salt, hash] = rest;
    const match = /^N=(\d{1,7}),r=(\d{1,3}),p=(\d{1,3})$/u.exec(parameterText ?? '');
    if (match === null) return null;
    const [,n,r,p] = match;
    const parsed = {N:Number(n),r:Number(r),p:Number(p),maxmem:DEFAULT_SCRYPT_PARAMETERS.maxmem};
    if (!Number.isInteger(parsed.N) || parsed.N < 16_384 || parsed.N > 1_048_576) return null;
    if (!Number.isInteger(parsed.r) || parsed.r < 1 || parsed.r > 32) return null;
    if (!Number.isInteger(parsed.p) || parsed.p < 1 || parsed.p > 16) return null;
    parameters = parsed;
    saltText = salt;
    hashText = hash;
  } else if (rest.length === 2) {
    [saltText,hashText] = rest;
  }
  if (saltText === undefined || hashText === undefined) return null;
  if (!BASE64URL_PATTERN.test(saltText) || !BASE64URL_PATTERN.test(hashText)) return null;
  const salt = Buffer.from(saltText,'base64url');
  const expected = Buffer.from(hashText,'base64url');
  if (salt.length < 8 || expected.length < 32 || expected.length > 128) return null;
  return {parameters,salt,expected};
};

export const hashPassword = (password: string): string => {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password,salt,KEY_LENGTH,DEFAULT_SCRYPT_PARAMETERS);
  return `${ALGORITHM}$${encodeParameters(DEFAULT_SCRYPT_PARAMETERS)}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
};

export const hashPasswordAsync = (password: string): Promise<string> => {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_BYTES);
  return new Promise<string>((resolve,reject) => {
    scrypt(password,salt,KEY_LENGTH,DEFAULT_SCRYPT_PARAMETERS,(error,derived) => {
      if (error) reject(error);
      else resolve(`${ALGORITHM}$${encodeParameters(DEFAULT_SCRYPT_PARAMETERS)}$${salt.toString('base64url')}$${derived.toString('base64url')}`);
    });
  });
};

export const verifyPassword = (password: string,encoded: string): boolean => {
  const parsed = parseHash(encoded);
  if (parsed === null) return false;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAXIMUM_PASSWORD_LENGTH) return false;
  try {
    const actual = scryptSync(password,parsed.salt,parsed.expected.length,parsed.parameters);
    return actual.length === parsed.expected.length && timingSafeEqual(actual,parsed.expected);
  } catch {
    return false;
  }
};

export const verifyPasswordAsync = (password: string,encoded: string): Promise<boolean> => {
  const parsed = parseHash(encoded);
  if (parsed === null) return Promise.resolve(false);
  if (typeof password !== 'string' || password.length === 0 || password.length > MAXIMUM_PASSWORD_LENGTH) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    scrypt(password,parsed.salt,parsed.expected.length,parsed.parameters,(error,actual) => {
      if (error) {
        resolve(false);
        return;
      }
      const expected = parsed.expected;
      resolve(actual.length === expected.length && timingSafeEqual(actual,expected));
    });
  });
};

/** True when the stored hash uses weaker or different parameters than the current defaults. */
export const passwordNeedsRehash = (encoded: string): boolean => {
  const parsed = parseHash(encoded);
  if (parsed === null) return true;
  return parsed.parameters.N !== DEFAULT_SCRYPT_PARAMETERS.N
    || parsed.parameters.r !== DEFAULT_SCRYPT_PARAMETERS.r
    || parsed.parameters.p !== DEFAULT_SCRYPT_PARAMETERS.p;
};
