import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation: object keys are sorted so that two structurally
 * equal values always produce the same string. Used for state comparison during
 * replay verification and for fingerprints.
 */
export const canonicalJson = (value: unknown): string => {
  const serialise = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Canonical JSON does not support non-finite numbers');
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map(serialise).join(',')}]`;
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const entries = keys
        .filter(key => record[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${serialise(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    throw new Error(`Canonical JSON does not support values of type ${typeof input}`);
  };
  return serialise(value);
};

/** Stable deep equality for JSON shaped data. */
export const jsonEquals = (left: unknown,right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** SHA-256 fingerprint of the canonical form of a value. */
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
