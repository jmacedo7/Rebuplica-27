export interface SimulationClock { now(): string; advance(days:number): SimulationClock; }
export class FixedSimulationClock implements SimulationClock {
 readonly #timestamp:Date;
 constructor(timestamp:string|Date){const date=timestamp instanceof Date?new Date(timestamp):new Date(timestamp);if(Number.isNaN(date.getTime()))throw new Error('Invalid simulation timestamp');this.#timestamp=date;}
 now():string{return this.#timestamp.toISOString();}
 advance(days:number):SimulationClock{if(!Number.isInteger(days)||days<0)throw new Error('Simulation days must be a non-negative integer');return new FixedSimulationClock(new Date(this.#timestamp.getTime()+days*86400000));}
}
