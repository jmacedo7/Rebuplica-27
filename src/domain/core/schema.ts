import type { DomainEvent } from './events.ts';
import { DOMAIN_EVENT_TYPES } from './events.ts';
import type { Snapshot } from './snapshot.ts';
import type { DecisionInput,DecisionRecord,GameState,WorldState } from './types.ts';

/**
 * Structural parsers for data that crosses a trust boundary (PostgreSQL JSONB, HTTP
 * bodies, fixtures). They fail loudly with a precise path instead of letting a
 * malformed object reach the simulation.
 */
export class SchemaError extends Error {
  readonly path: string;
  constructor(path: string,message: string) {
    super(`${path}: ${message}`);
    this.name = 'SchemaError';
    this.path = path;
  }
}

const fail = (path: string,message: string): never => {
  throw new SchemaError(path,message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown,path: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(path,'must be an object');

const requireString = (value: unknown,path: string,maxLength = 1024): string => {
  if (typeof value !== 'string') return fail(path,'must be a string');
  if (value.length === 0) return fail(path,'must not be empty');
  if (value.length > maxLength) return fail(path,`must not exceed ${maxLength} characters`);
  return value;
};

const requireInteger = (value: unknown,path: string,minimum: number,maximum: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(path,'must be an integer');
  if (value < minimum || value > maximum) return fail(path,`must be between ${minimum} and ${maximum}`);
  return value;
};

const requireIsoDate = (value: unknown,path: string): string => {
  const text = requireString(value,path,64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return fail(path,'must be an ISO-8601 timestamp');
  return text;
};

const requireNumberRecord = (value: unknown,path: string): Readonly<Record<string, number>> => {
  const record = requireRecord(value,path);
  const result: Record<string, number> = {};
  for (const [key,entry] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return fail(`${path}.${key}`,'key must match [A-Za-z][A-Za-z0-9_]*');
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return fail(`${path}.${key}`,'must be a finite number');
    result[key] = entry;
  }
  return Object.freeze(result);
};

const requireBooleanRecord = (value: unknown,path: string): Readonly<Record<string, boolean>> => {
  const record = requireRecord(value,path);
  const result: Record<string, boolean> = {};
  for (const [key,entry] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return fail(`${path}.${key}`,'key must match [A-Za-z][A-Za-z0-9_]*');
    if (typeof entry !== 'boolean') return fail(`${path}.${key}`,'must be a boolean');
    result[key] = entry;
  }
  return Object.freeze(result);
};

export const parseWorldState = (value: unknown,path = 'world'): WorldState => {
  const record = requireRecord(value,path);
  return Object.freeze({
    date: requireIsoDate(record['date'],`${path}.date`),
    economy: requireNumberRecord(record['economy'],`${path}.economy`),
    society: requireNumberRecord(record['society'],`${path}.society`),
    institutions: requireNumberRecord(record['institutions'],`${path}.institutions`),
    flags: requireBooleanRecord(record['flags'],`${path}.flags`),
  });
};

export const parseGameState = (value: unknown,path = 'state'): GameState => {
  const record = requireRecord(value,path);
  return Object.freeze({
    gameId: requireString(record['gameId'],`${path}.gameId`,128),
    ownerId: requireString(record['ownerId'],`${path}.ownerId`,128),
    seed: requireInteger(record['seed'],`${path}.seed`,0,4_294_967_295),
    turn: requireInteger(record['turn'],`${path}.turn`,0,1_000_000),
    world: parseWorldState(record['world'],`${path}.world`),
  });
};

export const parseSnapshot = (value: unknown,path = 'snapshot'): Snapshot => {
  const record = requireRecord(value,path);
  return Object.freeze({
    schemaVersion: requireInteger(record['schemaVersion'],`${path}.schemaVersion`,1,1),
    gameVersion: requireInteger(record['gameVersion'],`${path}.gameVersion`,1,1_000_000_000),
    state: parseGameState(record['state'],`${path}.state`),
  });
};

const parseDecisionInput = (value: unknown,path: string): DecisionInput => {
  const record = requireRecord(value,path);
  return Object.freeze({
    type: requireString(record['type'],`${path}.type`,64),
    payload: Object.freeze({...requireRecord(record['payload'],`${path}.payload`)}),
  });
};

const parseDecisionRecord = (value: unknown,path: string): DecisionRecord => {
  const record = requireRecord(value,path);
  return Object.freeze({
    type: requireString(record['type'],`${path}.type`,64),
    payload: Object.freeze({...requireRecord(record['payload'],`${path}.payload`)}),
    decisionId: requireString(record['decisionId'],`${path}.decisionId`,128),
    turn: requireInteger(record['turn'],`${path}.turn`,0,1_000_000),
    actorId: requireString(record['actorId'],`${path}.actorId`,128),
  });
};

export const parseDomainEvent = (value: unknown,path = 'event'): DomainEvent => {
  const record = requireRecord(value,path);
  const type = requireString(record['type'],`${path}.type`,64);
  if (!DOMAIN_EVENT_TYPES.includes(type as DomainEvent['type'])) return fail(`${path}.type`,`must be one of: ${DOMAIN_EVENT_TYPES.join(', ')}`);
  const envelope = {
    eventId: requireString(record['eventId'],`${path}.eventId`,128),
    version: requireInteger(record['version'],`${path}.version`,1,1_000_000_000),
    state: parseGameState(record['state'],`${path}.state`),
  };
  if (type === 'DecisionApplied') {
    return Object.freeze({type:'DecisionApplied',...envelope,decision:parseDecisionRecord(record['decision'],`${path}.decision`)});
  }
  if (type === 'TurnAdvanced') {
    return Object.freeze({
      type:'TurnAdvanced',
      ...envelope,
      turn: requireInteger(record['turn'],`${path}.turn`,1,1_000_000),
      days: requireInteger(record['days'],`${path}.days`,1,3650),
    });
  }
  if (type === 'SaveRestored') {
    return Object.freeze({
      type:'SaveRestored',
      ...envelope,
      saveId: requireString(record['saveId'],`${path}.saveId`,128),
      restoredFromVersion: requireInteger(record['restoredFromVersion'],`${path}.restoredFromVersion`,1,1_000_000_000),
    });
  }
  return Object.freeze({type:'GameCreated',...envelope});
};

export { parseDecisionInput };
