import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import {
  DecisionRegistry,
  DecisionValidationError,
  defaultDecisionRegistry,
} from '../../src/domain/core/decisions.ts';
import { DeterministicRng } from '../../src/domain/core/rng.ts';
import { applyDecision,createGame } from '../../src/domain/core/game.ts';
import type { DecisionInput,GameState } from '../../src/domain/core/types.ts';

const CONTEXT={rng:new DeterministicRng(1),date:'2027-01-01T00:00:00.000Z'};
const expectValidationError=(operation:()=>unknown):DecisionValidationError=>{
  try{operation();}catch(error){
    assert.ok(error instanceof DecisionValidationError,`expected DecisionValidationError, received ${String(error)}`);
    return error;
  }
  assert.fail('expected the operation to throw');
};

describe('decision registry',()=>{
  it('exposes the registered types in a stable order',()=>{
    const registry=defaultDecisionRegistry();
    assert.deepEqual(registry.types,['SET_ECONOMIC_INDICATOR','SET_FLAG']);
    assert.equal(registry.has('SET_FLAG'),true);
    assert.equal(registry.has('DROP_DATABASE'),false);
  });
  it('refuses duplicate registrations',()=>{
    const registry=new DecisionRegistry();
    const handler={type:'NOOP',apply:(state:GameState)=>state};
    registry.register(handler);
    assert.throws(()=>registry.register(handler),/already registered/u);
  });
  it('rejects unknown decision types during validation',()=>{
    const error=expectValidationError(()=>defaultDecisionRegistry().validate('NOPE',{}));
    assert.match(error.message,/SET_ECONOMIC_INDICATOR/u);
  });
  it('validates economic indicators',()=>{
    const registry=defaultDecisionRegistry();
    registry.validate('SET_ECONOMIC_INDICATOR',{key:'inflation',value:4.2});
    for(const payload of [{key:'inflation'},{key:'inflation',value:'4.2'},{key:'',value:1},{key:'1bad',value:1},{key:1,value:1},{key:'a b',value:1},{key:'inflation',value:Number.NaN}]){
      expectValidationError(()=>registry.validate('SET_ECONOMIC_INDICATOR',payload));
      expectValidationError(()=>registry.apply(createGame('user-1','game-1',1).state,{type:'SET_ECONOMIC_INDICATOR',payload},CONTEXT));
    }
  });
  it('validates flags',()=>{
    const registry=defaultDecisionRegistry();
    registry.validate('SET_FLAG',{key:'declared',value:true});
    for(const payload of [{key:'declared',value:'true'},{key:'declared',value:1},{value:true}]){
      expectValidationError(()=>registry.validate('SET_FLAG',payload));
    }
  });
  it('applies validated decisions immutably',()=>{
    const state=createGame('user-1','game-1',1).state;
    const registry=defaultDecisionRegistry();
    const input:DecisionInput={type:'SET_ECONOMIC_INDICATOR',payload:{key:'gdpGrowth',value:2.1}};
    const next=registry.apply(state,input,CONTEXT);
    assert.equal(next.world.economy['gdpGrowth'],2.1);
    assert.equal(Object.isFrozen(state.world.economy),false);
    assert.notEqual(next,state);
    assert.deepEqual(state.world.economy,{});
  });
});

describe('decision application',()=>{
  it('records the decision, the actor and the resulting version',()=>{
    const game=createGame('user-1','game-1',42,undefined,{idFactory:(()=>{let index=0;return()=>`id-${++index}`;})()});
    const next=applyDecision(game,'user-1',{type:'SET_FLAG',payload:{key:'declared',value:true}},defaultDecisionRegistry(),{idFactory:()=> 'id-decision'});
    assert.equal(next.version,2);
    const event=next.events[1];
    assert.ok(event);
    assert.equal(event.type,'DecisionApplied');
    if(event.type!=='DecisionApplied')assert.fail('expected a DecisionApplied event');
    assert.equal(event.decision.decisionId,'id-decision');
    assert.equal(event.decision.actorId,'user-1');
    assert.equal(event.decision.turn,0);
    assert.deepEqual(event.decision.payload,{key:'declared',value:true});
    assert.equal(event.state.world.flags['declared'],true);
  });
  it('denies decisions from another user',()=>{
    const game=createGame('user-1');
    assert.throws(()=>applyDecision(game,'user-2',{type:'SET_FLAG',payload:{key:'x',value:true}}),/not authorized/u);
  });
  it('rejects invalid payloads before mutating state',()=>{
    const game=createGame('user-1');
    assert.throws(()=>applyDecision(game,'user-1',{type:'SET_FLAG',payload:{key:'x',value:'yes'}}),DecisionValidationError);
    assert.throws(()=>applyDecision(game,'user-1',{type:'UNKNOWN',payload:{}}),DecisionValidationError);
  });
});
