import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { DecisionRegistry } from '../../src/domain/core/decisions.ts';
import type { DomainEvent } from '../../src/domain/core/events.ts';
import {
  advanceTurn,
  applyDecision,
  createGame,
  restoreFromSnapshot,
  type GameAggregate,
} from '../../src/domain/core/game.ts';
import { commandsFromEvents,replay,replayEvents,type ReplayCommand } from '../../src/domain/core/replay.ts';
import { createSnapshot } from '../../src/domain/core/snapshot.ts';
import { fingerprint } from '../../src/domain/shared/canonical.ts';

/** Handler that consumes the seeded RNG, to prove replay reproduces draws. */
const rngRegistry=():DecisionRegistry=>{
  const registry=new DecisionRegistry();
  registry.register({
    type:'DRAW',
    apply(state,_input,context){
      return {...state,world:{...state.world,economy:{...state.world.economy,drawn:Number(context.rng.nextFloat().toFixed(6))}}};
    },
  });
  return registry;
};

const buildGame=():GameAggregate=>{
  let counter=0;
  const idFactory=():string=>`id-${++counter}`;
  const registry=rngRegistry();
  let aggregate=createGame('user-1','11111111-1111-4111-8111-111111111111',4242,undefined,{idFactory});
  aggregate=applyDecision(aggregate,'user-1',{type:'DRAW',payload:{}},registry,{idFactory});
  aggregate=applyDecision(aggregate,'user-1',{type:'DRAW',payload:{}},registry,{idFactory});
  aggregate=advanceTurn(aggregate,30,{idFactory});
  aggregate=applyDecision(aggregate,'user-1',{type:'DRAW',payload:{}},registry,{idFactory});
  return aggregate;
};

describe('event replay',()=>{
  it('rebuilds the final state from the event stream alone',()=>{
    const aggregate=buildGame();
    const outcome=replayEvents(aggregate.events,{registry:rngRegistry()});
    assert.equal(outcome.consistent,true);
    assert.equal(outcome.events,aggregate.events.length);
    assert.equal(outcome.version,aggregate.version);
    assert.deepEqual(outcome.state,aggregate.state);
    assert.equal(outcome.fingerprint,fingerprint(aggregate.state));
  });
  it('reproduces random draws deterministically from the seed and version',()=>{
    const first=buildGame();
    const second=buildGame();
    assert.deepEqual(first.state,second.state);
    assert.equal(first.state.world.economy['drawn'],second.state.world.economy['drawn']);
    assert.equal(replayEvents(first.events,{registry:rngRegistry()}).consistent,true);
  });
  it('detects a state that was tampered with in storage',()=>{
    const aggregate=buildGame();
    const tampered=aggregate.events.map(event =>
      event.version===3 ? {...event,state:{...event.state,turn:99}} : event) as readonly DomainEvent[];
    const outcome=replayEvents(tampered,{registry:rngRegistry()});
    assert.equal(outcome.consistent,false);
    assert.equal(outcome.firstMismatchVersion,3);
  });
  it('refuses an event stream with a version gap',()=>{
    const aggregate=buildGame();
    const missing=aggregate.events.filter(event => event.version!==2);
    assert.throws(()=>replayEvents(missing,{registry:rngRegistry()}),/version gap/u);
  });
  it('refuses an empty stream or a stream that does not start with GameCreated',()=>{
    assert.throws(()=>replayEvents([]),/empty event stream/u);
    const aggregate=buildGame();
    assert.throws(()=>replayEvents(aggregate.events.slice(1)),/must start with GameCreated|version gap/u);
  });
  it('derives the replay commands from the persisted events',()=>{
    const aggregate=buildGame();
    const commands=commandsFromEvents(aggregate.events);
    assert.equal(commands.length,aggregate.events.length-1);
    assert.deepEqual(commands[2],{kind:'advanceTurn',days:30});
    assert.deepEqual(commands[0],{kind:'decision',actorId:'user-1',input:{type:'DRAW',payload:{}}});
  });
  it('treats SaveRestored as an explicit checkpoint',()=>{
    let counter=0;
    const idFactory=():string=>`id-${++counter}`;
    const registry=rngRegistry();
    let aggregate=createGame('user-1','22222222-2222-4222-8222-222222222222',7,undefined,{idFactory});
    aggregate=applyDecision(aggregate,'user-1',{type:'DRAW',payload:{}},registry,{idFactory});
    const snapshot=createSnapshot(aggregate.state,aggregate.version);
    aggregate=advanceTurn(aggregate,30,{idFactory});
    aggregate=restoreFromSnapshot(aggregate,snapshot,'33333333-3333-4333-8333-333333333333',{idFactory});
    assert.equal(aggregate.events.at(-1)?.type,'SaveRestored');
    const outcome=replayEvents(aggregate.events,{registry:rngRegistry()});
    assert.equal(outcome.consistent,true);
    assert.equal(outcome.checkpoints,1);
    assert.deepEqual(outcome.state,snapshot.state);
    // The turn that was rewound is still part of the history.
    assert.equal(aggregate.events.filter(event=>event.type==='TurnAdvanced').length,1);
  });
  it('reports determinism from real executions, not as an assumption',()=>{
    const commands:ReplayCommand[]=[
      {kind:'decision',actorId:'user-1',input:{type:'SET_FLAG',payload:{key:'declared',value:true}}},
      {kind:'decision',actorId:'user-1',input:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'gdpGrowth',value:2.1}}},
      {kind:'advanceTurn',days:30},
    ];
    const first=replay('user-1',7,commands);
    const second=replay('user-1',7,commands);
    assert.equal(first.deterministic,true);
    assert.deepEqual(first.aggregate.state,second.aggregate.state);
    assert.equal(fingerprint(first.aggregate.state),fingerprint(second.aggregate.state));
  });
  it('produces different worlds for different seeds',()=>{
    const commands:ReplayCommand[]=[{kind:'advanceTurn',days:30}];
    const left=replay('user-1',1,commands);
    const right=replay('user-1',2,commands);
    assert.equal(fingerprint(left.aggregate.state)===fingerprint(right.aggregate.state),false);
  });
});
