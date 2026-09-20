export type GameId=string;export type UserId=string;export type SaveId=string;export type EventId=string;export type Version=number;
export interface WorldState{readonly date:string;readonly economy:Readonly<Record<string,number>>;readonly society:Readonly<Record<string,number>>;readonly institutions:Readonly<Record<string,number>>;readonly flags:Readonly<Record<string,boolean>>;}
export interface GameState{readonly gameId:GameId;readonly ownerId:UserId;readonly seed:number;readonly turn:number;readonly world:WorldState;}
export interface DecisionInput{readonly type:string;readonly payload:Readonly<Record<string,unknown>>;}
export interface DecisionRecord extends DecisionInput{readonly decisionId:string;readonly turn:number;readonly actorId:UserId;}
