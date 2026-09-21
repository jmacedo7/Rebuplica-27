import type { LogLevel } from '../config/index.ts';

/**
 * Structured JSON logger: one line per event on stdout (warn/error go to stderr).
 *
 * Redaction is built in: field names that may carry credentials are replaced before
 * serialisation, so a password, token or secret can never reach the logs even if a
 * caller passes one by accident.
 */
export type { LogLevel };

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const REDACTED = '[REDACTED]';
const FORBIDDEN_KEY_PATTERN = /(password|passwd|secret|token|authorization|cookie|credential|apikey|api_key|hash)/iu;
const MAXIMUM_DEPTH = 4;
const MAXIMUM_ARRAY_ITEMS = 20;
const MAXIMUM_STRING_LENGTH = 512;

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string,fields?: LogFields): void;
  info(message: string,fields?: LogFields): void;
  warn(message: string,fields?: LogFields): void;
  error(message: string,fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly context?: LogFields | undefined;
  readonly sink?: ((line: string,level: LogLevel) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

const sanitise = (value: unknown,depth: number): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAXIMUM_STRING_LENGTH ? `${value.slice(0,MAXIMUM_STRING_LENGTH)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return '[VALUE]';
  if (value instanceof Error) return {name:value.name,message:value.message,stack:value.stack};
  if (Array.isArray(value)) {
    if (depth >= MAXIMUM_DEPTH) return '[TRUNCATED]';
    return value.slice(0,MAXIMUM_ARRAY_ITEMS).map(item => sanitise(item,depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAXIMUM_DEPTH) return '[TRUNCATED]';
    const result: Record<string, unknown> = {};
    for (const [key,entry] of Object.entries(value)) {
      result[key] = FORBIDDEN_KEY_PATTERN.test(key) ? REDACTED : sanitise(entry,depth + 1);
    }
    return result;
  }
  return REDACTED;
};

const defaultSink = (line: string,level: LogLevel): void => {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

class JsonLogger implements Logger {
  readonly level: LogLevel;
  readonly #context: LogFields;
  readonly #sink: (line: string,level: LogLevel) => void;
  readonly #now: () => Date;
  constructor(level: LogLevel,context: LogFields,sink: (line: string,level: LogLevel) => void,now: () => Date) {
    this.level = level;
    this.#context = context;
    this.#sink = sink;
    this.#now = now;
  }
  #write(level: LogLevel,message: string,fields: LogFields | undefined): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record = sanitise({...this.#context,...fields,message},0) as Record<string, unknown>;
    const line = JSON.stringify({time:this.#now().toISOString(),level,...record});
    this.#sink(line,level);
  }
  debug(message: string,fields?: LogFields): void { this.#write('debug',message,fields); }
  info(message: string,fields?: LogFields): void { this.#write('info',message,fields); }
  warn(message: string,fields?: LogFields): void { this.#write('warn',message,fields); }
  error(message: string,fields?: LogFields): void { this.#write('error',message,fields); }
  child(fields: LogFields): Logger {
    return new JsonLogger(this.level,{...this.#context,...fields},this.#sink,this.#now);
  }
}

export const createLogger = (options: LoggerOptions): Logger =>
  new JsonLogger(options.level,options.context ?? {},options.sink ?? defaultSink,options.now ?? (() => new Date()));

/** Logger that discards everything: used by tests that do not assert on logs. */
export const createSilentLogger = (): Logger => createLogger({level:'silent'});
