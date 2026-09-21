import type { DecisionRecord,EventId,GameState,SaveId,Version } from './types.ts';

/**
 * Persisted domain events. Every event carries the full state produced by the
 * transition it represents: events are the audit trail and the replay material,
 * while `games.state` is the materialised current state.
 */
export type DomainEvent =
  | {
      readonly type: 'GameCreated';
      readonly eventId: EventId;
      readonly version: Version;
      readonly state: GameState;
    }
  | {
      readonly type: 'DecisionApplied';
      readonly eventId: EventId;
      readonly version: Version;
      readonly decision: DecisionRecord;
      readonly state: GameState;
    }
  | {
      readonly type: 'TurnAdvanced';
      readonly eventId: EventId;
      readonly version: Version;
      readonly turn: number;
      readonly days: number;
      readonly state: GameState;
    }
  | {
      readonly type: 'SaveRestored';
      readonly eventId: EventId;
      readonly version: Version;
      readonly saveId: SaveId;
      readonly restoredFromVersion: Version;
      readonly state: GameState;
    };

export type DomainEventType = DomainEvent['type'];

export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = Object.freeze([
  'GameCreated',
  'DecisionApplied',
  'TurnAdvanced',
  'SaveRestored',
]);
