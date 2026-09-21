import { randomUUID } from 'node:crypto';
import { DecisionValidationError,defaultDecisionRegistry,type DecisionRegistry } from '../domain/core/decisions.ts';
import { DOMAIN_EVENT_TYPES,type DomainEvent } from '../domain/core/events.ts';
import {
  DEFAULT_TURN_DAYS,
  advanceTurn,
  applyDecision,
  createGame,
  restoreFromSnapshot,
  type GameAggregate,
} from '../domain/core/game.ts';
import { replayEvents,type ReplayOutcome } from '../domain/core/replay.ts';
import { createSnapshot } from '../domain/core/snapshot.ts';
import type { DecisionInput,GameState } from '../domain/core/types.ts';
import type {
  EventRecord,
  GameRecord,
  Page,
  PageRequest,
  Persistence,
  Repositories,
  SaveRecord,
} from '../persistence/ports.ts';
import { badRequest,notFound,validationError } from './errors.ts';

export interface GameView {
  readonly id: string;
  readonly seed: number;
  readonly turn: number;
  readonly currentVersion: number;
  readonly worldDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GameDetailView extends GameView {
  readonly state: GameState;
}

export interface SaveView {
  readonly id: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly turn: number;
  readonly worldDate: string;
  readonly createdAt: string;
}

export interface EventView {
  readonly version: number;
  readonly type: DomainEvent['type'];
  readonly eventId: string;
  readonly recordedAt: string;
  readonly event: DomainEvent;
}

export interface ReplayView {
  readonly consistent: boolean;
  readonly version: number;
  readonly turn: number;
  readonly events: number;
  readonly checkpoints: number;
  readonly firstMismatchVersion: number | null;
  readonly fingerprint: string;
}

export interface RestoreResult {
  readonly game: GameDetailView;
  readonly saveId: string;
  readonly restoredFromVersion: number;
}

const MAXIMUM_REPLAY_EVENTS = 5_000;
const REPLAY_PAGE_SIZE = 500;

const toGameView = (record: GameRecord): GameView => ({
  id:record.id,
  seed:record.seed,
  turn:record.state.turn,
  currentVersion:record.currentVersion,
  worldDate:record.state.world.date,
  createdAt:record.createdAt,
  updatedAt:record.updatedAt,
});

const toGameDetail = (record: GameRecord): GameDetailView => ({...toGameView(record),state:record.state});

const toSaveView = (record: SaveRecord): SaveView => ({
  id:record.id,
  version:record.version,
  schemaVersion:record.snapshot.schemaVersion,
  turn:record.snapshot.state.turn,
  worldDate:record.snapshot.state.world.date,
  createdAt:record.createdAt,
});

const toEventView = (record: EventRecord): EventView => ({
  version:record.event.version,
  type:record.event.type,
  eventId:record.event.eventId,
  recordedAt:record.recordedAt,
  event:record.event,
});

const toReplayView = (outcome: ReplayOutcome): ReplayView => ({
  consistent:outcome.consistent,
  version:outcome.version,
  turn:outcome.state.turn,
  events:outcome.events,
  checkpoints:outcome.checkpoints,
  firstMismatchVersion:outcome.firstMismatchVersion,
  fingerprint:outcome.fingerprint,
});

/**
 * Application service for the game aggregate.
 *
 * Every method that touches a game first proves ownership: a game id supplied by the
 * client is never trusted, and a game owned by somebody else is reported as missing
 * so the API does not leak the existence of other players' games (IDOR protection).
 */
export class GameService {
  readonly #persistence: Persistence;
  readonly #registry: DecisionRegistry;

  constructor(persistence: Persistence,registry: DecisionRegistry = defaultDecisionRegistry()) {
    this.#persistence = persistence;
    this.#registry = registry;
  }

  get decisionTypes(): readonly string[] {
    return this.#registry.types;
  }

  get eventTypes(): readonly string[] {
    return DOMAIN_EVENT_TYPES;
  }

  async create(actorId: string,options: {readonly seed?: number | undefined} = {}): Promise<GameDetailView> {
    const seed = options.seed ?? randomSeed();
    const aggregate = createGame(actorId,randomUUID(),seed);
    const record: GameRecord = {
      id:aggregate.state.gameId,
      ownerId:actorId,
      seed:aggregate.state.seed,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
      currentVersion:aggregate.version,
      state:aggregate.state,
    };
    const stored = await this.#persistence.transaction(async repositories => {
      const game = await repositories.games.create(record);
      await repositories.events.append(aggregate.events);
      await repositories.audit.record({
        actorId,
        action:'game.created',
        resourceType:'game',
        resourceId:game.id,
        metadata:{seed:game.seed},
      });
      return game;
    });
    return toGameDetail(stored);
  }

  async list(actorId: string,page: PageRequest): Promise<Page<GameView>> {
    const result = await this.#persistence.games.listByOwner(actorId,page);
    return {items:result.items.map(toGameView),total:result.total,limit:result.limit,offset:result.offset};
  }

  async get(actorId: string,gameId: string): Promise<GameDetailView> {
    const game = await this.#requireOwnedGame(this.#persistence,actorId,gameId);
    return toGameDetail(game);
  }

  async applyDecision(actorId: string,gameId: string,input: DecisionInput): Promise<GameDetailView> {
    try {
      this.#registry.validate(input.type,input.payload);
    } catch (error) {
      if (error instanceof DecisionValidationError) throw badRequest('INVALID_DECISION',error.message);
      throw error;
    }
    return this.#persistence.transaction(async repositories => {
      const game = await this.#requireOwnedGame(repositories,actorId,gameId);
      const aggregate = aggregateOf(game);
      const next = applyDecision(aggregate,actorId,input,this.#registry);
      const updated = await repositories.games.update(gameId,next.state,game.currentVersion);
      await repositories.events.append(newEventsOf(aggregate,next));
      await repositories.audit.record({
        actorId,
        action:'game.decision_applied',
        resourceType:'game',
        resourceId:gameId,
        metadata:{type:input.type,version:updated.currentVersion,turn:updated.state.turn},
      });
      return toGameDetail(updated);
    });
  }

  async advanceTurn(actorId: string,gameId: string,days: number = DEFAULT_TURN_DAYS): Promise<GameDetailView> {
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw validationError('days must be an integer between 1 and 3650');
    return this.#persistence.transaction(async repositories => {
      const game = await this.#requireOwnedGame(repositories,actorId,gameId);
      const aggregate = aggregateOf(game);
      const next = advanceTurn(aggregate,days,{actorId});
      const updated = await repositories.games.update(gameId,next.state,game.currentVersion);
      await repositories.events.append(newEventsOf(aggregate,next));
      await repositories.audit.record({
        actorId,
        action:'game.turn_advanced',
        resourceType:'game',
        resourceId:gameId,
        metadata:{days,version:updated.currentVersion,turn:updated.state.turn},
      });
      return toGameDetail(updated);
    });
  }

  async listEvents(
    actorId: string,
    gameId: string,
    options: PageRequest & {readonly afterVersion?: number | undefined},
  ): Promise<Page<EventView>> {
    await this.#requireOwnedGame(this.#persistence,actorId,gameId);
    const result = await this.#persistence.events.list(gameId,options);
    return {items:result.items.map(toEventView),total:result.total,limit:result.limit,offset:result.offset};
  }

  /** Rebuilds the state from the event stream and reports whether it matches the stored states. */
  async replay(actorId: string,gameId: string): Promise<ReplayView> {
    await this.#requireOwnedGame(this.#persistence,actorId,gameId);
    const events = await this.#loadAllEvents(this.#persistence,gameId);
    return toReplayView(replayEvents(events,{registry:this.#registry}));
  }

  async createSave(actorId: string,gameId: string): Promise<SaveView> {
    return this.#persistence.transaction(async repositories => {
      const game = await this.#requireOwnedGame(repositories,actorId,gameId);
      const save = await repositories.saves.create({
        id:randomUUID(),
        gameId,
        version:game.currentVersion,
        snapshot:createSnapshot(game.state,game.currentVersion),
        createdAt:new Date().toISOString(),
      });
      await repositories.audit.record({
        actorId,
        action:'game.save_created',
        resourceType:'game',
        resourceId:gameId,
        metadata:{saveId:save.id,version:save.version,schemaVersion:save.snapshot.schemaVersion},
      });
      return toSaveView(save);
    });
  }

  async listSaves(actorId: string,gameId: string,page: PageRequest): Promise<Page<SaveView>> {
    await this.#requireOwnedGame(this.#persistence,actorId,gameId);
    const result = await this.#persistence.saves.listByGame(gameId,page);
    return {items:result.items.map(toSaveView),total:result.total,limit:result.limit,offset:result.offset};
  }

  /**
   * Restores a save inside a single transaction. History is never deleted: the restored
   * state is written as a new `SaveRestored` event at `currentVersion + 1`, so the event
   * stream stays monotonic and replay treats the restore as an explicit checkpoint.
   */
  async restoreSave(actorId: string,gameId: string,saveId: string): Promise<RestoreResult> {
    return this.#persistence.transaction(async repositories => {
      const game = await this.#requireOwnedGame(repositories,actorId,gameId);
      const save = await repositories.saves.findById(saveId);
      if (save === null || save.gameId !== gameId) throw notFound('Save not found');
      const aggregate = aggregateOf(game);
      const next = restoreFromSnapshot(aggregate,save.snapshot,save.id,{actorId});
      const updated = await repositories.games.update(gameId,next.state,game.currentVersion);
      await repositories.events.append(newEventsOf(aggregate,next));
      await repositories.audit.record({
        actorId,
        action:'game.save_restored',
        resourceType:'game',
        resourceId:gameId,
        metadata:{saveId:save.id,restoredFromVersion:save.version,version:updated.currentVersion},
      });
      return {game:toGameDetail(updated),saveId:save.id,restoredFromVersion:save.version};
    });
  }

  async #requireOwnedGame(repositories: Repositories,actorId: string,gameId: string): Promise<GameRecord> {
    const game = await repositories.games.findById(gameId);
    if (game === null || game.ownerId !== actorId) throw notFound('Game not found');
    return game;
  }

  async #loadAllEvents(repositories: Repositories,gameId: string): Promise<readonly DomainEvent[]> {
    const events: DomainEvent[] = [];
    let offset = 0;
    for (;;) {
      const page = await repositories.events.list(gameId,{limit:REPLAY_PAGE_SIZE,offset});
      if (page.total > MAXIMUM_REPLAY_EVENTS) {
        throw badRequest('REPLAY_TOO_LARGE',`Replay is limited to ${MAXIMUM_REPLAY_EVENTS} events`);
      }
      for (const record of page.items) events.push(record.event);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return events;
    }
  }
}

const aggregateOf = (game: GameRecord): GameAggregate => ({state:game.state,version:game.currentVersion,events:[]});

/** Events produced by the transition: the aggregate carries no history from storage. */
const newEventsOf = (previous: GameAggregate,next: GameAggregate): readonly DomainEvent[] =>
  next.events.slice(previous.events.length);

const randomSeed = (): number => {
  const buffer = randomUUID().replace(/-/gu,'');
  return Number.parseInt(buffer.slice(0,8),16) >>> 0;
};
