import type { DecisionInput,GameState } from './types.ts';
import type { RandomSource } from './rng.ts';

export interface DecisionContext {
  readonly rng: RandomSource;
  readonly date: string;
}

/** Raised when a decision payload is not acceptable for its handler. */
export class DecisionValidationError extends Error {
  readonly decisionType: string;
  constructor(decisionType: string,message: string) {
    super(`${decisionType}: ${message}`);
    this.name = 'DecisionValidationError';
    this.decisionType = decisionType;
  }
}

export interface DecisionHandler {
  readonly type: string;
  /** Validates the payload before it is stored or applied; must throw on invalid input. */
  validate?(payload: Readonly<Record<string, unknown>>): void;
  apply(state: GameState,input: DecisionInput,context: DecisionContext): GameState;
}

export class DecisionRegistry {
  readonly #handlers = new Map<string,DecisionHandler>();

  register(handler: DecisionHandler): void {
    if (this.#handlers.has(handler.type)) throw new Error(`Decision handler already registered: ${handler.type}`);
    this.#handlers.set(handler.type,handler);
  }

  get types(): readonly string[] {
    return Object.freeze([...this.#handlers.keys()].sort());
  }

  has(type: string): boolean {
    return this.#handlers.has(type);
  }

  /** Validates payload shape for a known handler; unknown types are rejected. */
  validate(type: string,payload: Readonly<Record<string, unknown>>): void {
    const handler = this.#handlers.get(type);
    if (handler === undefined) throw new DecisionValidationError(type,`unknown decision type, expected one of: ${this.types.join(', ')}`);
    handler.validate?.(payload);
  }

  apply(state: GameState,input: DecisionInput,context: DecisionContext): GameState {
    const handler = this.#handlers.get(input.type);
    if (handler === undefined) throw new DecisionValidationError(input.type,`unknown decision type, expected one of: ${this.types.join(', ')}`);
    handler.validate?.(input.payload);
    return handler.apply(state,input,context);
  }
}

const INDICATOR_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

const readKey = (type: string,payload: Readonly<Record<string, unknown>>): string => {
  const key = payload['key'];
  if (typeof key !== 'string' || !INDICATOR_KEY_PATTERN.test(key)) {
    throw new DecisionValidationError(type,'payload.key must match [A-Za-z][A-Za-z0-9_]*');
  }
  return key;
};

export const defaultDecisionRegistry = (): DecisionRegistry => {
  const registry = new DecisionRegistry();
  registry.register({
    type:'SET_ECONOMIC_INDICATOR',
    validate(payload) {
      readKey('SET_ECONOMIC_INDICATOR',payload);
      const value = payload['value'];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new DecisionValidationError('SET_ECONOMIC_INDICATOR','payload.value must be a finite number');
    },
    apply(state,input) {
      const key = readKey(input.type,input.payload);
      const value = input.payload['value'] as number;
      return {...state,world:{...state.world,economy:{...state.world.economy,[key]:value}}};
    },
  });
  registry.register({
    type:'SET_FLAG',
    validate(payload) {
      readKey('SET_FLAG',payload);
      if (typeof payload['value'] !== 'boolean') throw new DecisionValidationError('SET_FLAG','payload.value must be a boolean');
    },
    apply(state,input) {
      const key = readKey(input.type,input.payload);
      const value = input.payload['value'] as boolean;
      return {...state,world:{...state.world,flags:{...state.world.flags,[key]:value}}};
    },
  });
  return registry;
};
