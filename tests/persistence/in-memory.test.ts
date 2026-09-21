import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe,it } from 'node:test';
import { createGame,applyDecision } from '../../src/domain/core/game.ts';
import { createSnapshot } from '../../src/domain/core/snapshot.ts';
import {
  DuplicateEventError,
  EmailConflictError,
  OptimisticConflictError,
  SaveVersionConflictError,
} from '../../src/persistence/errors.ts';
import { createInMemoryPersistence } from '../../src/persistence/in-memory.ts';
import type { GameRecord,SaveRecord } from '../../src/persistence/ports.ts';

const seedUser=async():Promise<{id:string;persistence:ReturnType<typeof createInMemoryPersistence>}>=>{
  const persistence=createInMemoryPersistence();
  const id=randomUUID();
  await persistence.users.create({id,email:`user-${id}@example.com`,passwordHash:'scrypt$x'});
  return {id,persistence};
};

const seedGame=async(ownerId:string,persistence:ReturnType<typeof createInMemoryPersistence>):Promise<GameRecord>=>{
  const aggregate=createGame(ownerId);
  const now=new Date().toISOString();
  const game=await persistence.games.create({
    id:aggregate.state.gameId,
    ownerId,
    seed:aggregate.state.seed,
    createdAt:now,
    updatedAt:now,
    currentVersion:1,
    state:aggregate.state,
  });
  await persistence.events.append(aggregate.events);
  return game;
};

describe('in-memory persistence (test adapter)',()=>{
  it('rejects duplicate emails and duplicate ids',async()=>{
    const persistence=createInMemoryPersistence();
    const id=randomUUID();
    await persistence.users.create({id,email:'player@example.com',passwordHash:'hash'});
    await assert.rejects(()=>persistence.users.create({id:randomUUID(),email:'player@example.com',passwordHash:'hash'}),EmailConflictError);
    await assert.rejects(()=>persistence.users.create({id,email:'other@example.com',passwordHash:'hash'}),EmailConflictError);
  });
  it('returns clones so callers cannot mutate stored rows',async()=>{
    const { persistence }=await seedUser();
    const game=await seedGame((await persistence.users.findByEmail([...persistence.users.records.values()][0]?.email ?? ''))?.id ?? '',persistence);
    const loaded=await persistence.games.findById(game.id);
    assert.ok(loaded);
    (loaded as {seed:number}).seed=99;
    const reloaded=await persistence.games.findById(game.id);
    assert.equal(reloaded?.seed,game.seed);
  });
  it('scopes the game listing to the owner with pagination metadata',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    const other=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    await persistence.users.create({id:other,email:'other@example.com',passwordHash:'x'});
    for(let index=0;index<3;index+=1)await seedGame(owner,persistence);
    await seedGame(other,persistence);
    const firstPage=await persistence.games.listByOwner(owner,{limit:2,offset:0});
    assert.equal(firstPage.total,3);
    assert.equal(firstPage.items.length,2);
    assert.ok(firstPage.items.every(record=>record.ownerId===owner));
    const secondPage=await persistence.games.listByOwner(owner,{limit:2,offset:2});
    assert.equal(secondPage.items.length,1);
  });
  it('fails optimistic updates when the expected version is stale',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    const game=await seedGame(owner,persistence);
    const decision=applyDecision({state:game.state,version:game.currentVersion,events:[]},owner,{type:'SET_FLAG',payload:{key:'a',value:true}});
    const updated=await persistence.games.update(game.id,decision.state,game.currentVersion);
    assert.equal(updated.currentVersion,2);
    await assert.rejects(()=>persistence.games.update(game.id,decision.state,1),OptimisticConflictError);
    await assert.rejects(()=>persistence.games.update(randomUUID(),decision.state,1),OptimisticConflictError);
  });
  it('enforces one event per (game, version)',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    const game=await seedGame(owner,persistence);
    const events=await persistence.events.list(game.id,{limit:10,offset:0});
    assert.equal(events.total,1);
    await assert.rejects(()=>persistence.events.append(events.items.map(record=>record.event)),DuplicateEventError);
  });
  it('orders events by version and supports afterVersion',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    const game=await seedGame(owner,persistence);
    const decision=applyDecision({state:game.state,version:game.currentVersion,events:[]},owner,{type:'SET_FLAG',payload:{key:'a',value:true}});
    await persistence.games.update(game.id,decision.state,game.currentVersion);
    await persistence.events.append(decision.events.slice(-1));
    const all=await persistence.events.list(game.id,{limit:10,offset:0});
    assert.deepEqual(all.items.map(record=>record.event.version),[1,2]);
    assert.ok(all.items.every(record=>record.recordedAt.endsWith('Z')));
    const newer=await persistence.events.list(game.id,{limit:10,offset:0,afterVersion:1});
    assert.deepEqual(newer.items.map(record=>record.event.version),[2]);
    assert.equal(newer.total,1);
  });
  it('refuses two saves for the same game version',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    const game=await seedGame(owner,persistence);
    const record:SaveRecord={id:randomUUID(),gameId:game.id,version:game.currentVersion,snapshot:createSnapshot(game.state,game.currentVersion),createdAt:new Date().toISOString()};
    await persistence.saves.create(record);
    await assert.rejects(()=>persistence.saves.create({...record,id:randomUUID()}),SaveVersionConflictError);
    const latest=await persistence.saves.findLatest(game.id);
    assert.equal(latest?.id,record.id);
    assert.equal((await persistence.saves.listByGame(game.id,{limit:10,offset:0})).total,1);
  });
  it('serialises transactions so concurrent writers cannot interleave',async()=>{
    const persistence=createInMemoryPersistence();
    const owner=randomUUID();
    await persistence.users.create({id:owner,email:'owner@example.com',passwordHash:'x'});
    const game=await seedGame(owner,persistence);
    const order:string[]=[];
    const first=persistence.transaction(async tx=>{
      order.push('first:start');
      const current=await tx.games.findById(game.id);
      await new Promise(resolve=>setTimeout(resolve,10));
      const updated=await tx.games.update(game.id,{...game.state,turn:1},current?.currentVersion ?? 1);
      order.push('first:end');
      return updated.currentVersion;
    });
    const second=persistence.transaction(async tx=>{
      order.push('second:start');
      const current=await tx.games.findById(game.id);
      const updated=await tx.games.update(game.id,{...game.state,turn:2},current?.currentVersion ?? 1);
      order.push('second:end');
      return updated.currentVersion;
    });
    const versions=await Promise.all([first,second]);
    assert.deepEqual(versions,[2,3]);
    assert.deepEqual(order,['first:start','first:end','second:start','second:end']);
  });
  it('records audit entries with the actor and no credentials',async()=>{
    const persistence=createInMemoryPersistence();
    const actor=randomUUID();
    await persistence.audit.record({actorId:actor,action:'game.created',resourceType:'game',resourceId:'g-1',metadata:{seed:1}});
    assert.equal(persistence.audit.entries.length,1);
    assert.equal(persistence.audit.entries[0]?.actorId,actor);
    assert.equal(JSON.stringify(persistence.audit.entries).includes('password'),false);
  });
  it('supports the readiness probe',async()=>{
    await assert.doesNotReject(()=>createInMemoryPersistence().ping());
  });
});
