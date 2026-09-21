import { fingerprint,jsonEquals } from '../shared/canonical.ts';
import { defaultDecisionRegistry,type DecisionRegistry } from './decisions.ts';
import type { DomainEvent } from './events.ts';
import {
  applyDecision,
  advanceTurn,
  createGame,
  restoreFromSnapshot,
  type GameAggregate,
  type MutationOptions,
} from './game.ts';
import { createSnapshot } from './snapshot.ts';
import type { DecisionInput,GameState,SaveId,UserId } from './types.ts';

export type ReplayCommand =
  | { readonly kind: 'decision'; readonly actorId: UserId; readonly input: DecisionInput }
  | { readonly kind: 'advanceTurn'; readonly days?: number }
  | {
      readonly kind: 'restore';
      readonly saveId: SaveId;
      readonly state: GameState;
      readonly restoredFromVersion: number;
    };

export interface ReplayResult {
  readonly aggregate: GameAggregate;
  readonly deterministic: boolean;
}

export interface ReplayOutcome {
  /** State rebuilt exclusively from the persisted event stream. */
  readonly state: GameState;
  readonly version: number;
  readonly events: number;
  readonly checkpoints: number;
  /** True when every rebuilt state matched the state recorded in its event. */
  readonly consistent: boolean;
  readonly firstMismatchVersion: number | null;
  readonly fingerprint: string;
}

export interface ReplayOptions {
  readonly registry?: DecisionRegistry | undefined;
  readonly idFactory?: MutationOptions['idFactory'] | undefined;
}

/** Deterministic id source used by replays: ids must not influence derived state. */
const replayIds = (): MutationOptions['idFactory'] => {
  let counter = 0;
  return () => {
    counter += 1;
    return `replay-${counter}`;
  };
};

const applyCommand = (
  aggregate: GameAggregate,
  command: ReplayCommand,
  registry: DecisionRegistry,
  options: ReplayOptions,
): GameAggregate => {
  const mutationOptions: MutationOptions = {idFactory: options.idFactory ?? replayIds()};
  if (command.kind === 'decision') return applyDecision(aggregate,command.actorId,command.input,registry,mutationOptions);
  if (command.kind === 'advanceTurn') return advanceTurn(aggregate,command.days ?? undefined,mutationOptions);
  return restoreFromSnapshot(
    aggregate,
    createSnapshot(command.state,command.restoredFromVersion),
    command.saveId,
    mutationOptions,
  );
};

/** Translates one persisted event into the command that reproduces it (null for the initial event). */
export const commandFromEvent = (event: DomainEvent): ReplayCommand | null => {
  if (event.type === 'DecisionApplied') {
    return {kind:'decision',actorId:event.decision.actorId,input:{type:event.decision.type,payload:event.decision.payload}};
  }
  if (event.type === 'TurnAdvanced') return {kind:'advanceTurn',days:event.days};
  if (event.type === 'SaveRestored') {
    return {
      kind:'restore',
      saveId:event.saveId,
      state:structuredClone(event.state),
      restoredFromVersion:event.restoredFromVersion,
    };
  }
  return null;
};

/** Translates a persisted trace into the commands that reproduce it. */
export const commandsFromEvents = (events: readonly DomainEvent[]): readonly ReplayCommand[] => {
  const commands: ReplayCommand[] = [];
  for (const event of events) {
    const command = commandFromEvent(event);
    if (command !== null) commands.push(command);
  }
  return commands;
};

const orderEvents = (events: readonly DomainEvent[]): readonly DomainEvent[] => {
  const ordered = [...events].sort((left,right) => left.version - right.version);
  if (ordered.length === 0) throw new Error('Cannot replay an empty event stream');
  for (const [index,event] of ordered.entries()) {
    if (event.version !== index + 1) throw new Error(`Event stream has a version gap at ${index + 1}: found ${event.version}`);
  }
  const head = ordered[0];
  if (head === undefined || head.type !== 'GameCreated') throw new Error('Event stream must start with GameCreated');
  return ordered;
};

/**
 * Rebuilds the game state from the persisted event stream and checks the result
 * against the state recorded in every event. This is the integrity proof used by
 * tests and by the diagnostics endpoint: it fails when the world is not a pure
 * function of the initial state plus the ordered commands.
 */
export const replayEvents = (events: readonly DomainEvent[],options: ReplayOptions = {}): ReplayOutcome => {
  const ordered = orderEvents(events);
  const head = ordered[0];
  if (head === undefined) throw new Error('Cannot replay an empty event stream');
  const registry = options.registry ?? defaultDecisionRegistry();
  let aggregate: GameAggregate = {state:structuredClone(head.state),version:1,events:[head]};
  let consistent = true;
  let firstMismatchVersion: number | null = null;
  let checkpoints = 0;
  for (const event of ordered.slice(1)) {
    const command = commandFromEvent(event);
    if (command === null) throw new Error(`Unsupported event type at version ${event.version}`);
    aggregate = applyCommand(aggregate,command,registry,options);
    if (event.type === 'SaveRestored') checkpoints += 1;
    if (aggregate.version !== event.version || !jsonEquals(aggregate.state,event.state)) {
      consistent = false;
      firstMismatchVersion ??= event.version;
    }
  }
  return {
    state:aggregate.state,
    version:aggregate.version,
    events:ordered.length,
    checkpoints,
    consistent,
    firstMismatchVersion,
    fingerprint:fingerprint(aggregate.state),
  };
};

/**
 * Replays a command list from a fresh game. `deterministic` is computed, not
 * assumed: the command list is folded twice and both fingerprints must match.
 */
export const replay = (
  ownerId: UserId,
  seed: number,
  commands: readonly ReplayCommand[],
  startDate?: string,
): ReplayResult => {
  const registry = defaultDecisionRegistry();
  const fold = (): GameAggregate => {
    let aggregate = createGame(ownerId,'replay',seed,startDate,{idFactory:replayIds()});
    for (const command of commands) aggregate = applyCommand(aggregate,command,registry,{});
    return aggregate;
  };
  const first = fold();
  const second = fold();
  return {aggregate:first,deterministic:fingerprint(first.state) === fingerprint(second.state)};
};
