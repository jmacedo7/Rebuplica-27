import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after,before,describe,it } from 'node:test';
import { Client } from 'pg';
import { advanceTurn,applyDecision,createGame } from '../../src/domain/core/game.ts';
import { replayEvents } from '../../src/domain/core/replay.ts';
import { createSnapshot } from '../../src/domain/core/snapshot.ts';
import { fingerprint } from '../../src/domain/shared/canonical.ts';
import { DatabaseUnavailableError,InvalidIdentifierError,InvalidStoredDataError,OptimisticConflictError } from '../../src/persistence/errors.ts';
import { createPostgresPersistence,type PostgresPersistence } from '../../src/persistence/postgres.ts';
import { databaseSkipReason,hasDatabase,persistenceOptionsFor,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';

describe('PostgreSQL persistence',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;
  let db: PostgresPersistence | undefined;

  before(async()=>{
    database=await provisionDatabase('persistence');
    db=createPostgresPersistence(persistenceOptionsFor(database.url));
  },{timeout:120_000});

  after(async()=>{
    await db?.close();
    await database?.drop();
  });

  const context=():{db:PostgresPersistence;url:string}=>{
    assert.ok(db,'persistence not initialised');
    assert.ok(database,'database not provisioned');
    return {db,url:database.url};
  };

  const newUser=async():Promise<{id:string;email:string}>=>{
    const { db: persistence }=context();
    const id=randomUUID();
    const email=`user-${id}@example.com`;
    const user=await persistence.users.create({id,email,passwordHash:'scrypt$N=32768,r=8,p=1$c2FsdA$aGFzaA'});
    return {id:user.id,email:user.email};
  };

  const newGame=async(ownerId:string):Promise<{id:string;version:number}>=>{
    const { db: persistence }=context();
    const aggregate=createGame(ownerId);
    const now=new Date().toISOString();
    const game=await persistence.transaction(async tx=>{
      const created=await tx.games.create({
        id:aggregate.state.gameId,
        ownerId,
        seed:aggregate.state.seed,
        createdAt:now,
        updatedAt:now,
        currentVersion:aggregate.version,
        state:aggregate.state,
      });
      await tx.events.append(aggregate.events);
      return created;
    });
    return {id:game.id,version:game.currentVersion};
  };

  it('applies the migrations when provisioning and reports them idempotently',async()=>{
    const { url }=context();
    assert.deepEqual([...database?.migrations.applied ?? []],['0001','0002','0003']);
    const { applyMigrations }=await import('../../src/persistence/migrations.ts');
    const second=await applyMigrations({connectionString:url,ssl:'disable'});
    assert.deepEqual([...second.applied],[]);
    assert.deepEqual([...second.skipped],['0001','0002','0003']);
  });

  it('persists users with a database generated timestamp',async()=>{
    const { db: persistence }=context();
    const { id,email }=await newUser();
    const byEmail=await persistence.users.findByEmail(email);
    const byId=await persistence.users.findById(id);
    assert.equal(byEmail?.id,id);
    assert.equal(byId?.email,email);
    assert.ok(byEmail?.createdAt.endsWith('Z'));
    assert.equal(await persistence.users.findById(randomUUID()),null);
  });

  it('rejects duplicate emails at the database level',async()=>{
    const { db: persistence }=context();
    const { email }=await newUser();
    await assert.rejects(
      ()=>persistence.users.create({id:randomUUID(),email,passwordHash:'scrypt$x'}),
      (error:unknown)=>error instanceof Error&&(error as {code?:string}).code==='EMAIL_CONFLICT',
    );
  });

  it('stores and reloads the full game state',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const loaded=await persistence.games.findById(game.id);
    assert.equal(loaded?.currentVersion,1);
    assert.equal(loaded?.state.ownerId,user.id);
    assert.equal(loaded?.state.world.date,'2027-01-01T00:00:00.000Z');
    assert.deepEqual(loaded?.state.world.economy,{});
  });

  it('applies optimistic locking and returns the authoritative row',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const loaded=await persistence.games.findById(game.id);
    assert.ok(loaded);
    const decision=applyDecision({state:loaded.state,version:loaded.currentVersion,events:[]},user.id,{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}});
    const updated=await persistence.games.update(game.id,decision.state,loaded.currentVersion);
    assert.equal(updated.currentVersion,2);
    assert.equal(updated.state.world.economy['inflation'],4.2);
    assert.ok(new Date(updated.updatedAt).getTime()>=new Date(loaded.updatedAt).getTime());
    await assert.rejects(()=>persistence.games.update(game.id,decision.state,1),OptimisticConflictError);
  });

  it('lists games per owner with pagination and totals',async()=>{
    const { db: persistence }=context();
    const owner=await newUser();
    const other=await newUser();
    await newGame(owner.id);
    await newGame(owner.id);
    await newGame(other.id);
    const first=await persistence.games.listByOwner(owner.id,{limit:1,offset:0});
    assert.equal(first.total,2);
    assert.equal(first.items.length,1);
    const second=await persistence.games.listByOwner(owner.id,{limit:1,offset:1});
    assert.equal(second.items.length,1);
    assert.notEqual(first.items[0]?.id,second.items[0]?.id);
    assert.ok(first.items.every(record=>record.ownerId===owner.id));
  });

  it('stores the ordered event stream with recorded timestamps',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const loaded=await persistence.games.findById(game.id);
    assert.ok(loaded);
    const decision=applyDecision({state:loaded.state,version:loaded.currentVersion,events:[]},user.id,{type:'SET_FLAG',payload:{key:'declared',value:true}});
    const turn=advanceTurn({state:decision.state,version:decision.version,events:[]},30,{actorId:user.id});
    await persistence.transaction(async tx=>{
      const updated=await tx.games.update(game.id,decision.state,loaded.currentVersion);
      assert.equal(updated.currentVersion,2);
      await tx.events.append(decision.events);
    });
    await persistence.transaction(async tx=>{
      await tx.games.update(game.id,turn.state,2);
      await tx.events.append(turn.events);
    });
    const events=await persistence.events.list(game.id,{limit:10,offset:0});
    assert.equal(events.total,3);
    assert.deepEqual(events.items.map(record=>record.event.version),[1,2,3]);
    assert.deepEqual(events.items.map(record=>record.event.type),['GameCreated','DecisionApplied','TurnAdvanced']);
    assert.ok(events.items.every(record=>record.recordedAt.endsWith('Z')));
    const filtered=await persistence.events.list(game.id,{limit:10,offset:0,afterVersion:2});
    assert.equal(filtered.total,1);
    assert.equal(filtered.items[0]?.event.version,3);
    // The stored trace replays to the stored state.
    const replay=replayEvents(events.items.map(record=>record.event));
    const current=await persistence.games.findById(game.id);
    assert.equal(replay.consistent,true);
    assert.equal(replay.version,current?.currentVersion);
    assert.equal(fingerprint(replay.state),fingerprint(current?.state));
  });

  it('rejects a duplicate (game, version) event',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const events=await persistence.events.list(game.id,{limit:10,offset:0});
    const existing=events.items[0]?.event;
    assert.ok(existing);
    await assert.rejects(
      ()=>persistence.events.append([existing]),
      (error:unknown)=>(error as {code?:string}).code==='DUPLICATE_EVENT',
    );
  });

  it('stores saves with their snapshot and refuses two saves per version',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const loaded=await persistence.games.findById(game.id);
    assert.ok(loaded);
    const save=await persistence.saves.create({
      id:randomUUID(),
      gameId:game.id,
      version:loaded.currentVersion,
      snapshot:createSnapshot(loaded.state,loaded.currentVersion),
      createdAt:new Date().toISOString(),
    });
    assert.equal(save.version,1);
    assert.deepEqual(save.snapshot.state,loaded.state);
    assert.equal((await persistence.saves.findById(save.id))?.id,save.id);
    assert.equal((await persistence.saves.findLatest(game.id))?.id,save.id);
    assert.equal((await persistence.saves.listByGame(game.id,{limit:10,offset:0})).total,1);
    await assert.rejects(
      ()=>persistence.saves.create({...save,id:randomUUID()}),
      (error:unknown)=>(error as {code?:string}).code==='SAVE_VERSION_CONFLICT',
    );
  });

  it('writes audit entries without credentials',async()=>{
    const { db: persistence,url }=context();
    const user=await newUser();
    await persistence.audit.record({actorId:user.id,action:'auth.login_succeeded',resourceType:'user',resourceId:user.id,metadata:{email:user.email}});
    await persistence.audit.record({actorId:null,action:'auth.login_failed',resourceType:'user',resourceId:null,metadata:{email:'unknown@example.com'}});
    const client=new Client({connectionString:url});
    await client.connect();
    try{
      const result=await client.query<{action: string; actor_id: string | null; metadata: Record<string,unknown>}>('SELECT action, actor_id, metadata FROM audit_log WHERE action LIKE $1 ORDER BY id ASC',['auth.login%']);
      assert.deepEqual(result.rows.map(row=>row.action),['auth.login_succeeded','auth.login_failed']);
      assert.equal(result.rows[0]?.actor_id,user.id);
      assert.equal(result.rows[1]?.actor_id,null);
      assert.equal(JSON.stringify(result.rows).includes('password'),false);
    }finally{
      await client.end();
    }
  });

  it('rolls the whole transaction back when any statement fails',async()=>{
    const { db: persistence }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const loaded=await persistence.games.findById(game.id);
    assert.ok(loaded);
    const decision=applyDecision({state:loaded.state,version:loaded.currentVersion,events:[]},user.id,{type:'SET_FLAG',payload:{key:'x',value:true}});
    await assert.rejects(()=>persistence.transaction(async tx=>{
      await tx.games.update(game.id,decision.state,loaded.currentVersion);
      await tx.events.append([...decision.events,{...decision.events[0],eventId:randomUUID()} as (typeof decision.events)[number]]);
    }),/(DUPLICATE_EVENT|duplicate key)/u);
    const afterFailure=await persistence.games.findById(game.id);
    assert.equal(afterFailure?.currentVersion,1);
    assert.equal((await persistence.events.list(game.id,{limit:10,offset:0})).total,1);
  });

  it('rejects malformed identifiers before they reach SQL',async()=>{
    const { db: persistence }=context();
    await assert.rejects(()=>persistence.games.findById('not-a-uuid'),InvalidIdentifierError);
    await assert.rejects(()=>persistence.users.findById('1'),InvalidIdentifierError);
    await assert.rejects(()=>persistence.saves.findById('nope'),InvalidIdentifierError);
  });

  it('reports corrupt stored state instead of returning it',async()=>{
    const { db: persistence,url }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    const client=new Client({connectionString:url});
    await client.connect();
    try{
      await client.query('UPDATE games SET state = $1::jsonb WHERE id = $2',[JSON.stringify({turn:'many'}),game.id]);
    }finally{
      await client.end();
    }
    await assert.rejects(()=>persistence.games.findById(game.id),InvalidStoredDataError);
  });

  it('keeps data after the pool is closed and reopened',async()=>{
    const { db: first,url }=context();
    const user=await newUser();
    const game=await newGame(user.id);
    await first.close();
    const reopened=createPostgresPersistence(persistenceOptionsFor(url));
    try{
      const loaded=await reopened.games.findById(game.id);
      assert.equal(loaded?.id,game.id);
      assert.equal(loaded?.ownerId,user.id);
      assert.equal((await reopened.games.listByOwner(user.id,{limit:10,offset:0})).total,1);
    }finally{
      await reopened.close();
    }
    db=createPostgresPersistence(persistenceOptionsFor(url));
  });

  it('surfaces an unavailable database as a typed error',async()=>{
    const broken=createPostgresPersistence(persistenceOptionsFor('postgres://127.0.0.1:1/nope'));
    try{
      await assert.rejects(()=>broken.ping(),DatabaseUnavailableError);
      await assert.rejects(()=>broken.transaction(async()=>undefined),DatabaseUnavailableError);
    }finally{
      await broken.close();
    }
  });
});
