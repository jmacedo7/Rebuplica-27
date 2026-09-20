import type { DecisionRecord,EventId,GameState,Version } from './types.ts';
export type DomainEvent={readonly type:'GameCreated';readonly eventId:EventId;readonly version:Version;readonly state:GameState}|{readonly type:'DecisionApplied';readonly eventId:EventId;readonly version:Version;readonly decision:DecisionRecord;readonly state:GameState}|{readonly type:'TurnAdvanced';readonly eventId:EventId;readonly version:Version;readonly turn:number;readonly state:GameState};
export const eventStreamKey=(gameId:string):string=>`game:${gameId}`;
