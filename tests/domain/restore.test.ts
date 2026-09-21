import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { defaultDecisionRegistry } from '../../src/domain/core/decisions.ts';
import { advanceTurn,applyDecision,createGame,restoreFromSnapshot,type GameAggregate } from '../../src/domain/core/game.ts';
import { CURRENT_SNAPSHOT_VERSION,createSnapshot,restoreSnapshot } from '../../src/domain/core/snapshot.ts';

const SAVE_ID='44444444-4444-4444-8444-444444444444';

const progressed=():GameAggregate=>{
  const game=createGame('user-1','game-1',21);
  const withDecision=applyDecision(game,'user-1',{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}},defaultDecisionRegistry());
  return advanceTurn(withDecision,30);
};

describe('snapshots',()=>{
  it('captures the state and the game version',()=>{
    const game=progressed();
    const snapshot=createSnapshot(game.state,game.version);
    assert.equal(snapshot.schemaVersion,CURRENT_SNAPSHOT_VERSION);
    assert.equal(snapshot.gameVersion,game.version);
    assert.deepEqual(snapshot.state,game.state);
  });
  it('restores a deep copy, not the original object',()=>{
    const game=progressed();
    const restored=restoreSnapshot(createSnapshot(game.state,game.version));
    assert.deepEqual(restored,game.state);
    assert.notEqual(restored,game.state);
    assert.notEqual(restored.world,game.state.world);
  });
  it('refuses an unsupported schema version or an invalid game version',()=>{
    const game=progressed();
    assert.throws(()=>restoreSnapshot({...createSnapshot(game.state,game.version),schemaVersion:2}),/Unsupported snapshot schema version/u);
    assert.throws(()=>restoreSnapshot({...createSnapshot(game.state,game.version),gameVersion:0}),/Invalid snapshot game version/u);
  });
});

describe('restoring a save',()=>{
  it('appends a checkpoint event and keeps the previous history',()=>{
    const game=progressed();
    const snapshot=createSnapshot(game.state,game.version);
    const later=advanceTurn(game,30);
    const restored=restoreFromSnapshot(later,snapshot,SAVE_ID,{actorId:'user-1'});
    assert.equal(restored.version,later.version+1);
    assert.deepEqual(restored.state,snapshot.state);
    assert.equal(restored.state.turn,1);
    assert.equal(restored.events.length,later.events.length+1);
    assert.deepEqual(restored.events.slice(0,later.events.length),later.events);
    const event=restored.events.at(-1);
    assert.ok(event);
    assert.equal(event.type,'SaveRestored');
    if(event.type!=='SaveRestored')assert.fail('expected SaveRestored');
    assert.equal(event.saveId,SAVE_ID);
    assert.equal(event.restoredFromVersion,snapshot.gameVersion);
  });
  it('refuses a snapshot from another game or another owner',()=>{
    const game=progressed();
    const foreignGame=createGame('user-1','other-game',1);
    assert.throws(()=>restoreFromSnapshot(game,createSnapshot(foreignGame.state,foreignGame.version),SAVE_ID),/does not belong to this game/u);
    const otherOwner=createGame('user-2','game-1',1);
    assert.throws(()=>restoreFromSnapshot(game,createSnapshot(otherOwner.state,otherOwner.version),SAVE_ID),/does not belong to this game/u);
  });
  it('refuses a snapshot from the future',() => {
    const game=progressed();
    const ahead=createSnapshot(game.state,game.version+5);
    assert.throws(()=>restoreFromSnapshot(game,ahead,SAVE_ID),/newer than the game version/u);
  });
  it('denies restore by a different actor',() => {
    const game=progressed();
    const snapshot=createSnapshot(game.state,game.version);
    assert.throws(()=>restoreFromSnapshot(game,snapshot,SAVE_ID,{actorId:'user-2'}),/not authorized/u);
  });
  it('keeps versions monotonic so later writes still lock correctly',() => {
    const game=progressed();
    const restored=restoreFromSnapshot(game,createSnapshot(game.state,game.version),SAVE_ID);
    assert.equal(restored.version,game.version+1);
    const after=applyDecision(restored,'user-1',{type:'SET_FLAG',payload:{key:'after_restore',value:true}},defaultDecisionRegistry());
    assert.equal(after.version,restored.version+1);
    assert.equal(after.state.world.flags['after_restore'],true);
    // The restored world is the saved one, so indicators written before the save survive.
    assert.equal(after.state.world.economy['inflation'],4.2);
  });
});
