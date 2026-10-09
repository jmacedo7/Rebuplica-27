import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { advanceTurn,applyDecision,createGame,restoreFromSnapshot,type GameAggregate } from '../../src/domain/core/game.ts';
import { createSnapshot } from '../../src/domain/core/snapshot.ts';
import { commandsFromEvents,replay,replayEvents } from '../../src/domain/core/replay.ts';
import { DeterministicRng } from '../../src/domain/core/rng.ts';
import { canonicalJson,fingerprint } from '../../src/domain/shared/canonical.ts';

/**
 * Golden master: a fixed script over a fixed seed must always produce exactly the
 * same world, event stream and fingerprint. Any accidental change to the
 * simulation rules, to the canonical serialisation or to the event payloads breaks
 * these frozen expectations instead of silently shipping a different game.
 */

const OWNER = '00000000-0000-4000-8000-000000000001';
const GAME = '00000000-0000-4000-8000-0000000000aa';
const SEED = 2027;

/** Deterministic id source: replaces randomUUID so fixtures stay stable. */
const scriptedIds = (): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter.toString().padStart(4,'0')}`;
  };
};

const runScript = (): GameAggregate => {
  const idFactory = scriptedIds();
  let aggregate = createGame(OWNER,GAME,SEED,undefined,{idFactory});
  aggregate = applyDecision(aggregate,OWNER,{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}},undefined,{idFactory});
  aggregate = applyDecision(aggregate,OWNER,{type:'SET_ECONOMIC_INDICATOR',payload:{key:'gdpGrowth',value:1.8}},undefined,{idFactory});
  aggregate = applyDecision(aggregate,OWNER,{type:'SET_FLAG',payload:{key:'taxReformSent',value:true}},undefined,{idFactory});
  aggregate = advanceTurn(aggregate,30,{idFactory,actorId:OWNER});
  aggregate = applyDecision(aggregate,OWNER,{type:'SET_ECONOMIC_INDICATOR',payload:{key:'unemployment',value:7.9}},undefined,{idFactory});
  aggregate = advanceTurn(aggregate,90,{idFactory,actorId:OWNER});
  return aggregate;
};

const GOLDEN_STATE = {
  gameId:GAME,
  ownerId:OWNER,
  seed:SEED,
  turn:2,
  world:{
    date:'2027-05-01T00:00:00.000Z',
    economy:{inflation:4.2,gdpGrowth:1.8,unemployment:7.9},
    society:{},
    institutions:{},
    flags:{taxReformSent:true},
  },
};

const GOLDEN_FINGERPRINT = 'e9460f672d811eef6d674077247e6e83026442e69bf040e969c61ff289cc95ff';

describe('golden master: scripted game over a fixed seed',()=>{
  it('produces the frozen world state',()=>{
    const aggregate = runScript();
    assert.equal(aggregate.version,7);
    assert.deepEqual(JSON.parse(JSON.stringify(aggregate.state)),GOLDEN_STATE);
  });

  it('produces the frozen canonical fingerprint',()=>{
    assert.equal(fingerprint(runScript().state),GOLDEN_FINGERPRINT);
  });

  it('produces the frozen event stream',()=>{
    const events = runScript().events;
    assert.deepEqual(events.map(event => [event.version,event.type,event.eventId]),[
      [1,'GameCreated','id-0001'],
      [2,'DecisionApplied','id-0003'],
      [3,'DecisionApplied','id-0005'],
      [4,'DecisionApplied','id-0007'],
      [5,'TurnAdvanced','id-0008'],
      [6,'DecisionApplied','id-0010'],
      [7,'TurnAdvanced','id-0011'],
    ]);
  });

  it('is byte-for-byte reproducible across runs',()=>{
    assert.equal(canonicalJson(runScript().state),canonicalJson(runScript().state));
    assert.equal(canonicalJson(runScript().events),canonicalJson(runScript().events));
  });

  it('replays the persisted stream back to the same state',()=>{
    const aggregate = runScript();
    const outcome = replayEvents(aggregate.events);
    assert.equal(outcome.consistent,true);
    assert.equal(outcome.firstMismatchVersion,null);
    assert.equal(outcome.version,aggregate.version);
    assert.equal(outcome.fingerprint,GOLDEN_FINGERPRINT);
  });

  it('re-folds the command list deterministically',()=>{
    const commands = commandsFromEvents(runScript().events);
    const result = replay(OWNER,SEED,commands);
    assert.equal(result.deterministic,true);
    assert.equal(result.aggregate.state.turn,GOLDEN_STATE.turn);
    assert.equal(result.aggregate.state.world.date,GOLDEN_STATE.world.date);
    assert.deepEqual(JSON.parse(JSON.stringify(result.aggregate.state.world.economy)),GOLDEN_STATE.world.economy);
  });

  it('keeps a restore auditable: history grows, state rewinds',()=>{
    const aggregate = runScript();
    const checkpoint = createSnapshot(aggregate.events[3]!.state,4);
    const idFactory = scriptedIds();
    const restored = restoreFromSnapshot(aggregate,checkpoint,'save-1',{idFactory,actorId:OWNER});
    assert.equal(restored.version,8);
    assert.equal(restored.state.turn,0);
    assert.equal(restored.state.world.date,'2027-01-01T00:00:00.000Z');
    assert.equal(restored.events.length,8);
    const outcome = replayEvents(restored.events);
    assert.equal(outcome.consistent,true);
    assert.equal(outcome.checkpoints,1);
  });

  it('pins the deterministic RNG sequence for the golden seed',()=>{
    const rng = new DeterministicRng(SEED);
    assert.deepEqual([rng.nextUint32(),rng.nextUint32(),rng.nextUint32()],[525440309,2467518990,4061012679]);
    const forked = new DeterministicRng(SEED).fork('elections');
    assert.notEqual(forked.nextUint32(),new DeterministicRng(SEED).nextUint32());
    assert.equal(new DeterministicRng(SEED).fork('elections').nextUint32(),new DeterministicRng(SEED).fork('elections').nextUint32());
  });

  it('diverges for a different seed',()=>{
    const other = createGame(OWNER,GAME,SEED + 1,undefined,{idFactory:scriptedIds()});
    assert.notEqual(fingerprint(other.state),fingerprint(createGame(OWNER,GAME,SEED,undefined,{idFactory:scriptedIds()}).state));
  });
});
