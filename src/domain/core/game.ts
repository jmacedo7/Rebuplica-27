import { randomUUID } from 'node:crypto';
import { DeterministicRng } from './rng.ts';
import { defaultDecisionRegistry,type DecisionRegistry } from './decisions.ts';
import type { DomainEvent } from './events.ts';
import type { Snapshot } from './snapshot.ts';
import { restoreSnapshot } from './snapshot.ts';
import type { DecisionInput,DecisionRecord,GameId,GameState,SaveId,UserId } from './types.ts';

/** Injectable id source so tests and replays can be fully deterministic. */
export type IdFactory = () => string;

export interface MutationOptions {
  readonly idFactory?: IdFactory | undefined;
}

export interface GameAggregate {
  readonly state: GameState;
  readonly version: number;
  readonly events: readonly DomainEvent[];
}

export const DEFAULT_START_DATE = '2027-01-01T00:00:00.000Z';
export const DEFAULT_TURN_DAYS = 30;

export const createGame = (
  ownerId: UserId,
  gameId: GameId = randomUUID(),
  seed = 1,
  startDate = DEFAULT_START_DATE,
  options: MutationOptions = {},
): GameAggregate => {
  if (ownerId.trim() === '') throw new Error('Game owner is required');
  if (!Number.isInteger(seed)) throw new Error('Game seed must be an integer');
  if (Number.isNaN(new Date(startDate).getTime())) throw new Error('Game start date is invalid');
  const state: GameState = {
    gameId,
    ownerId,
    seed: seed >>> 0,
    turn: 0,
    world: {date: startDate,economy:{},society:{},institutions:{},flags:{}},
  };
  const event: DomainEvent = {type:'GameCreated',eventId:(options.idFactory ?? randomUUID)(),version:1,state};
  return {state,version:1,events:[event]};
};

export const applyDecision = (
  aggregate: GameAggregate,
  actorId: UserId,
  input: DecisionInput,
  registry: DecisionRegistry = defaultDecisionRegistry(),
  options: MutationOptions = {},
): GameAggregate => {
  if (actorId !== aggregate.state.ownerId) throw new Error('Actor is not authorized for this game');
  const decision: DecisionRecord = {
    type: input.type,
    payload: input.payload,
    decisionId:(options.idFactory ?? randomUUID)(),
    turn: aggregate.state.turn,
    actorId,
  };
  const next = registry.apply(aggregate.state,input,{
    rng: new DeterministicRng(aggregate.state.seed ^ aggregate.version),
    date: aggregate.state.world.date,
  });
  const version = aggregate.version + 1;
  const event: DomainEvent = {type:'DecisionApplied',eventId:(options.idFactory ?? randomUUID)(),version,decision,state:next};
  return {state:next,version,events:[...aggregate.events,event]};
};

export const advanceTurn = (
  aggregate: GameAggregate,
  days = DEFAULT_TURN_DAYS,
  options: MutationOptions & { readonly actorId?: UserId | undefined } = {},
): GameAggregate => {
  if (options.actorId !== undefined && options.actorId !== aggregate.state.ownerId) {
    throw new Error('Actor is not authorized for this game');
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Turn duration must be an integer between 1 and 3650 days');
  const current = new Date(aggregate.state.world.date);
  if (Number.isNaN(current.getTime())) throw new Error('Game contains invalid world date');
  const nextDate = new Date(current.getTime() + days * 86_400_000).toISOString();
  const next: GameState = {
    ...aggregate.state,
    turn: aggregate.state.turn + 1,
    world: {...aggregate.state.world,date:nextDate},
  };
  const version = aggregate.version + 1;
  const event: DomainEvent = {
    type:'TurnAdvanced',
    eventId:(options.idFactory ?? randomUUID)(),
    version,
    turn: next.turn,
    days,
    state: next,
  };
  return {state:next,version,events:[...aggregate.events,event]};
};

/**
 * Restores a snapshot into a game.
 *
 * Semantics: restoring never deletes history. A `SaveRestored` event is appended at
 * the next version with the restored state, so the event stream stays monotonic for
 * optimistic locking and keeps an auditable record of the rewind. Replay treats
 * `SaveRestored` as a checkpoint (state replacement).
 */
export const restoreFromSnapshot = (
  aggregate: GameAggregate,
  snapshot: Snapshot,
  saveId: SaveId,
  options: MutationOptions & { readonly actorId?: UserId | undefined } = {},
): GameAggregate => {
  if (options.actorId !== undefined && options.actorId !== aggregate.state.ownerId) {
    throw new Error('Actor is not authorized for this game');
  }
  const restored = restoreSnapshot(snapshot);
  if (restored.gameId !== aggregate.state.gameId) throw new Error('Snapshot does not belong to this game');
  if (restored.ownerId !== aggregate.state.ownerId) throw new Error('Snapshot does not belong to this game owner');
  if (snapshot.gameVersion > aggregate.version) throw new Error('Snapshot version is newer than the game version');
  const version = aggregate.version + 1;
  const event: DomainEvent = {
    type:'SaveRestored',
    eventId:(options.idFactory ?? randomUUID)(),
    version,
    saveId,
    restoredFromVersion: snapshot.gameVersion,
    state: restored,
  };
  return {state:restored,version,events:[...aggregate.events,event]};
};
