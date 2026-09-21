/**
 * Typed persistence failures. Adapters (in-memory and PostgreSQL) must throw these
 * same errors so the application layer never inspects driver specific codes or
 * matches on message strings.
 */
export type PersistenceErrorCode =
  | 'OPTIMISTIC_CONFLICT'
  | 'EMAIL_CONFLICT'
  | 'SAVE_VERSION_CONFLICT'
  | 'DUPLICATE_EVENT'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_STORED_DATA'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  override readonly cause: unknown;
  constructor(code: PersistenceErrorCode,message: string,cause?: unknown) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

/** Thrown when an optimistic update lost a race and no row matched the expected version. */
export class OptimisticConflictError extends PersistenceError {
  constructor(message = 'OPTIMISTIC_CONFLICT',cause?: unknown) {
    super('OPTIMISTIC_CONFLICT',message,cause);
    this.name = 'OptimisticConflictError';
  }
}

/** Thrown when a unique email constraint rejects a registration. */
export class EmailConflictError extends PersistenceError {
  constructor(message = 'USER_EMAIL_CONFLICT',cause?: unknown) {
    super('EMAIL_CONFLICT',message,cause);
    this.name = 'EmailConflictError';
  }
}

/** Thrown when a save already exists for the same (game_id, version) pair. */
export class SaveVersionConflictError extends PersistenceError {
  constructor(message = 'SAVE_VERSION_CONFLICT',cause?: unknown) {
    super('SAVE_VERSION_CONFLICT',message,cause);
    this.name = 'SaveVersionConflictError';
  }
}

/** Thrown when a domain event with the same (game_id, version) pair already exists. */
export class DuplicateEventError extends PersistenceError {
  constructor(message = 'DUPLICATE_EVENT',cause?: unknown) {
    super('DUPLICATE_EVENT',message,cause);
    this.name = 'DuplicateEventError';
  }
}

/** Thrown when an identifier is not a valid UUID and must never reach SQL. */
export class InvalidIdentifierError extends PersistenceError {
  constructor(message = 'INVALID_IDENTIFIER',cause?: unknown) {
    super('INVALID_IDENTIFIER',message,cause);
    this.name = 'InvalidIdentifierError';
  }
}

/** Thrown when stored JSON does not satisfy the domain schema. */
export class InvalidStoredDataError extends PersistenceError {
  constructor(message = 'INVALID_STORED_DATA',cause?: unknown) {
    super('INVALID_STORED_DATA',message,cause);
    this.name = 'InvalidStoredDataError';
  }
}

/** Thrown when the database cannot be reached or is not accepting queries. */
export class DatabaseUnavailableError extends PersistenceError {
  constructor(message = 'DATABASE_UNAVAILABLE',cause?: unknown) {
    super('UNAVAILABLE',message,cause);
    this.name = 'DatabaseUnavailableError';
  }
}

export const isPersistenceError = (value: unknown): value is PersistenceError => value instanceof PersistenceError;
