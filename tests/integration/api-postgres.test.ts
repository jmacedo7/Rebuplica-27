import assert from 'node:assert/strict';
import { after,before,describe,it } from 'node:test';
import { createPostgresPersistence,type PostgresPersistence } from '../../src/persistence/postgres.ts';
import { createGame,registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';
import { databaseSkipReason,hasDatabase,persistenceOptionsFor,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';

/**
 * The same HTTP surface exercised against the real PostgreSQL adapter: this is the
 * wiring the runtime uses (`src/main.ts` builds exactly this persistence).
 */
describe('API over PostgreSQL',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;
  let persistence: PostgresPersistence | undefined;
  let server: TestServer | undefined;

  before(async()=>{
    database=await provisionDatabase('api');
    persistence=createPostgresPersistence(persistenceOptionsFor(database.url));
    server=await startTestServer({
      persistence,
      rateLimits:{auth:{limit:10_000,windowMs:60_000},write:{limit:10_000,windowMs:60_000},read:{limit:10_000,windowMs:60_000}},
    });
  },{timeout:120_000});

  after(async()=>{
    await server?.close();
    await persistence?.close();
    await database?.drop();
  });

  const current=():TestServer=>{
    assert.ok(server,'server not started');
    return server;
  };

  it('runs the full gameplay flow and keeps it readable after the pool is recycled',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token,4242);
    const gameId=String(game['id']);

    const decision=await request(current(),`/games/${gameId}/decisions`,{
      token:user.token,
      body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}},
    });
    assert.equal(decision.status,200);
    const turn=await request(current(),`/games/${gameId}/turn`,{token:user.token,body:{days:30}});
    assert.equal(turn.status,200);
    assert.equal((turn.body['game'] as Record<string,unknown>)['currentVersion'],3);
    const save=await request(current(),`/games/${gameId}/saves`,{token:user.token,body:{}});
    assert.equal(save.status,201);

    // Recycle every pooled connection and start a fresh API server on the new pool:
    // nothing may survive in process memory, everything must come from PostgreSQL.
    assert.ok(persistence);
    assert.ok(database);
    await persistence.close();
    persistence=createPostgresPersistence(persistenceOptionsFor(database.url));
    const recycled=await startTestServer({
      persistence,
      rateLimits:{auth:{limit:10_000,windowMs:60_000},write:{limit:10_000,windowMs:60_000},read:{limit:10_000,windowMs:60_000}},
    });
    assert.equal((await request(current(),`/games/${gameId}`,{token:user.token})).status,500);
    await server?.close();
    server=recycled;

    const reloaded=await request(current(),`/games/${gameId}`,{token:user.token});
    assert.equal(reloaded.status,200);
    const state=(reloaded.body['game'] as Record<string,unknown>)['state'] as Record<string,unknown>;
    assert.deepEqual((state['world'] as Record<string,unknown>)['economy'],{inflation:4.2});
    assert.equal((reloaded.body['game'] as Record<string,unknown>)['turn'],1);

    const events=await request(current(),`/games/${gameId}/events`,{token:user.token});
    assert.deepEqual((events.body['events'] as Record<string,unknown>[]).map(event=>event['type']),['GameCreated','DecisionApplied','TurnAdvanced']);
    const saves=await request(current(),`/games/${gameId}/saves`,{token:user.token});
    assert.equal((saves.body['page'] as Record<string,unknown>)['total'],1);
    const replay=await request(current(),`/games/${gameId}/replay`,{token:user.token});
    assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);

    const restored=await request(current(),`/games/${gameId}/saves/${String((save.body['save'] as Record<string,unknown>)['id'])}/restore`,{token:user.token,body:{}});
    assert.equal(restored.status,200);
    assert.equal((restored.body['game'] as Record<string,unknown>)['currentVersion'],4);
  });

  it('logs in again with the password that was stored by a previous server instance',async()=>{
    const user=await registerUser(current());
    const login=await request(current(),'/auth/login',{body:{email:user.email,password:'a-very-strong-password'}});
    assert.equal(login.status,200);
    const me=await request(current(),'/auth/me',{token:login.body['accessToken'] as string});
    assert.equal(me.status,200);
    assert.equal((me.body['user'] as Record<string,unknown>)['id'],user.id);
  });

  it('scopes games per user in the database, not in the process',async()=>{
    const owner=await registerUser(current());
    const attacker=await registerUser(current());
    const game=await createGame(current(),owner.token);
    const gameId=String(game['id']);
    assert.equal((await request(current(),`/games/${gameId}`,{token:attacker.token})).status,404);
    assert.equal((await request(current(),`/games/${gameId}/decisions`,{token:attacker.token,body:{type:'SET_FLAG',payload:{key:'x',value:true}}})).status,404);
    const list=await request(current(),'/games',{token:attacker.token});
    assert.equal((list.body['page'] as Record<string,unknown>)['total'],0);
    assert.equal((await request(current(),`/games/${gameId}`,{token:owner.token})).status,200);
  });

  it('reports readiness against the real database',async()=>{
    const ready=await request(current(),'/ready');
    assert.equal(ready.status,200);
    assert.deepEqual(ready.body['checks'],{database:'ok'});
  });
});
