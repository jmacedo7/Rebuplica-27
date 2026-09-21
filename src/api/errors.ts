import { DecisionValidationError } from '../domain/core/decisions.ts';
import { SchemaError } from '../domain/core/schema.ts';
import { isPersistenceError } from '../persistence/errors.ts';
import { InvalidTokenError,WeakPasswordError } from '../security/index.ts';

/**
 * Transport level error. `status` is the HTTP status and `code` a stable machine
 * readable identifier the frontend can branch on. Messages are safe for clients:
 * they never contain SQL, stack traces, file paths or internal details.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly unknown[] | undefined;
  constructor(status: number,code: string,message: string,details?: readonly unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string,message: string,details?: readonly unknown[]): ApiError => new ApiError(400,code,message,details);
export const validationError = (message: string,details?: readonly unknown[]): ApiError => badRequest('VALIDATION_ERROR',message,details);
export const unauthorized = (message = 'Authentication required'): ApiError => new ApiError(401,'UNAUTHORIZED',message);
export const forbidden = (message = 'You do not have access to this resource'): ApiError => new ApiError(403,'FORBIDDEN',message);
export const notFound = (message = 'Resource not found'): ApiError => new ApiError(404,'NOT_FOUND',message);
export const conflict = (code: string,message: string): ApiError => new ApiError(409,code,message);
export const payloadTooLarge = (message = 'Request body is too large'): ApiError => new ApiError(413,'PAYLOAD_TOO_LARGE',message);
export const unsupportedMediaType = (message = 'Request body must be JSON'): ApiError => new ApiError(415,'UNSUPPORTED_MEDIA_TYPE',message);
export const rateLimited = (message = 'Too many requests'): ApiError => new ApiError(429,'RATE_LIMITED',message);
export const serviceUnavailable = (message = 'Service temporarily unavailable'): ApiError => new ApiError(503,'SERVICE_UNAVAILABLE',message);
export const internalError = (message = 'Internal server error'): ApiError => new ApiError(500,'INTERNAL_ERROR',message);

export interface MappedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: readonly unknown[] | undefined;
  /** True when the error is unexpected and must be logged with its stack trace. */
  readonly unexpected: boolean;
}

const mapped = (status: number,code: string,message: string,details?: readonly unknown[],unexpected = false): MappedError =>
  ({status,code,message,details,unexpected});

/**
 * Single place where every error category becomes an HTTP response. Business rules
 * never answer 200; infrastructure failures answer 503; unknown failures answer a
 * generic 500 and are logged internally.
 */
export const mapError = (error: unknown): MappedError => {
  if (error instanceof ApiError) return mapped(error.status,error.code,error.message,error.details);
  if (error instanceof SchemaError) return mapped(400,'VALIDATION_ERROR',error.message,undefined);
  if (error instanceof DecisionValidationError) return mapped(400,'INVALID_DECISION',error.message,undefined);
  // Malformed percent-encoding in the path or query string is a client mistake.
  if (error instanceof URIError) return mapped(400,'VALIDATION_ERROR','Malformed URL encoding',undefined);
  if (error instanceof InvalidTokenError) return mapped(401,'UNAUTHORIZED','Authentication required',undefined);
  if (error instanceof WeakPasswordError) return mapped(400,'WEAK_PASSWORD',error.message,undefined);
  if (isPersistenceError(error)) {
    switch (error.code) {
      case 'OPTIMISTIC_CONFLICT':
        return mapped(409,'CONFLICT','The game changed while this request was being processed; reload and try again');
      case 'EMAIL_CONFLICT':
        return mapped(409,'EMAIL_ALREADY_EXISTS','Email already exists',undefined);
      case 'SAVE_VERSION_CONFLICT':
        return mapped(409,'SAVE_CONFLICT','A save already exists for this game version');
      case 'DUPLICATE_EVENT':
        return mapped(409,'CONFLICT','Conflicting game version; reload and try again');
      case 'INVALID_IDENTIFIER':
        return mapped(400,'VALIDATION_ERROR','Invalid identifier');
      case 'INVALID_STORED_DATA':
        return mapped(500,'CORRUPT_STATE','Stored game data is invalid',undefined,true);
      case 'UNAVAILABLE':
        return mapped(503,'SERVICE_UNAVAILABLE','Storage is temporarily unavailable',undefined,true);
      default:
        return mapped(500,'INTERNAL_ERROR','Internal server error',undefined,true);
    }
  }
  return mapped(500,'INTERNAL_ERROR','Internal server error',undefined,true);
};
