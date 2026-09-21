import type { DecisionInput } from '../domain/core/types.ts';
import { badRequest,validationError } from './errors.ts';

/**
 * Input validation for untrusted data reaching the API: JSON bodies, path
 * parameters and query strings. Every validator throws an `ApiError` with a stable
 * code so the frontend can render a useful message without parsing prose.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DECISION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__','constructor','prototype']);
const MAXIMUM_EMAIL_LENGTH = 320;
const MAXIMUM_PASSWORD_LENGTH = 200;
const MAXIMUM_DECISION_PAYLOAD_BYTES = 4096;
const MAXIMUM_DECISION_KEYS = 16;
const DECISION_NUMBER_LIMIT = 1e12;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

export const requireUuid = (value: unknown,field: string): string => {
  if (!isUuid(value)) throw validationError(`${field} must be a UUID`);
  return value;
};

export const requireBodyKey = (body: Record<string, unknown>,key: string): unknown => {
  if (!Object.hasOwn(body,key)) throw validationError(`${key} is required`);
  return body[key];
};

export const requireString = (
  body: Record<string,unknown>,
  key: string,
  options: {readonly minLength?: number; readonly maxLength?: number} = {},
): string => {
  const value = requireBodyKey(body,key);
  const maxLength = options.maxLength ?? 500;
  const minLength = options.minLength ?? 1;
  if (typeof value !== 'string') throw validationError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < minLength) throw validationError(`${key} must contain at least ${minLength} characters`);
  if (trimmed.length > maxLength) throw validationError(`${key} must contain at most ${maxLength} characters`);
  return trimmed;
};

/** Rejects unexpected properties so typos and smuggling attempts fail loudly. */
export const rejectUnknownKeys = (body: Record<string,unknown>,allowed: readonly string[]): void => {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw validationError(`Unexpected propert${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`);
};

export const validateEmail = (raw: string): string => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAXIMUM_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalized)) {
    throw badRequest('INVALID_EMAIL','Email is invalid');
  }
  return normalized;
};

export const validatePassword = (value: unknown): string => {
  if (typeof value !== 'string') throw validationError('password must be a string');
  if (value.length > MAXIMUM_PASSWORD_LENGTH) throw validationError(`password must contain at most ${MAXIMUM_PASSWORD_LENGTH} characters`);
  // Exact rules (length, entropy policy) live in the password module so HTTP and
  // domain agree on a single definition of a weak password.
  return value;
};

export interface Pagination {
  readonly limit: number;
  readonly offset: number;
}

export const parsePagination = (
  searchParams: URLSearchParams,
  options: {readonly defaultLimit?: number; readonly maxLimit?: number} = {},
): Pagination => {
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 100;
  const limit = readIntegerQuery(searchParams,'limit',defaultLimit,1,maxLimit);
  const offset = readIntegerQuery(searchParams,'offset',0,0,1_000_000);
  return {limit,offset};
};

const readIntegerQuery = (searchParams: URLSearchParams,key: string,fallback: number,minimum: number,maximum: number): number => {
  const raw = searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw validationError(`${key} must be a non-negative integer`);
  const value = Number(raw.trim());
  if (value < minimum || value > maximum) throw validationError(`${key} must be between ${minimum} and ${maximum}`);
  return value;
};

export const parseAfterVersion = (searchParams: URLSearchParams): number | undefined => {
  const raw = searchParams.get('afterVersion');
  if (raw === null || raw.trim() === '') return undefined;
  if (!/^\d+$/u.test(raw.trim())) throw validationError('afterVersion must be a non-negative integer');
  const value = Number(raw.trim());
  if (value < 0 || value > 1_000_000_000) throw validationError('afterVersion must be between 0 and 1000000000');
  return value;
};

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/**
 * Validates a decision payload. Only flat primitive values are accepted, keys must
 * be identifier like (which also removes `__proto__` style keys), the payload is
 * size limited and unknown structures are rejected instead of being stored blindly.
 */
export const validateDecisionPayload = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError('payload must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAXIMUM_DECISION_KEYS) throw validationError(`payload must not contain more than ${MAXIMUM_DECISION_KEYS} properties`);
  const result: Record<string, unknown> = {};
  for (const [key,entry] of entries) {
    if (FORBIDDEN_KEYS.has(key) || !DECISION_KEY_PATTERN.test(key)) throw validationError(`payload key "${key}" is not allowed`);
    if (!isPrimitive(entry)) throw validationError(`payload.${key} must be a string, number or boolean`);
    if (typeof entry === 'number' && Math.abs(entry) > DECISION_NUMBER_LIMIT) throw validationError(`payload.${key} is out of range`);
    if (typeof entry === 'string' && entry.length > 256) throw validationError(`payload.${key} must contain at most 256 characters`);
    result[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(result),'utf8') > MAXIMUM_DECISION_PAYLOAD_BYTES) {
    throw validationError(`payload must not exceed ${MAXIMUM_DECISION_PAYLOAD_BYTES} bytes`);
  }
  return Object.freeze(result);
};

export const validateDecisionInput = (
  value: unknown,
  knownTypes: readonly string[],
): DecisionInput => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError('decision must be an object');
  const record = value as Record<string, unknown>;
  rejectUnknownKeys(record,['type','payload']);
  const type = record['type'];
  if (typeof type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(type)) throw validationError('decision.type must be an upper snake case identifier');
  if (!knownTypes.includes(type)) throw validationError(`decision.type must be one of: ${knownTypes.join(', ')}`);
  const payload = Object.hasOwn(record,'payload') ? record['payload'] : {};
  return {type,payload:validateDecisionPayload(payload)};
};
