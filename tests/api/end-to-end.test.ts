import assert from 'node:assert/strict';
import { after,before,describe,it } from 'node:test';
import { createPostgresPersistence,type PostgresPersistence } from '../../src/persistence/postgres.ts';
import { registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';
import { databaseSkipReason,hasDatabase,persistenceOptionsFor,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';

/**
 * End-to-end: one player, one match, the whole loop over real PostgreSQL —
 * register, login, create, decide, advance, inspect history, save, keep playing,
 * restore and verify replay integrity. No in-memory shortcuts.
 */
describe('end-to-end gameplay over PostgreSQL',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;
  let persistence: PostgresPersistence | undefined;
  let server: TestServer | undefined;

  before(async()=>{
    database = await provisionDatabase('e2e');
    persistence = createPostgresPersistence(persistenceOptionsFor(database.url));
    server = await startTestServer({
      persistence,
      rateLimits:{auth:{limit:10_000,windowMs:60_000},write:{limit:10_000,windowMs:60_000},read:{limit:10_000,windowMs:60_000}},
    });
  },{timeout:120_000});

  after(async()=>{
    await server?.close();
    await persistence?.close();
    await database?.drop();
  });

  const current = ():TestServer => {
    assert.ok(server,'server not started');
    return server;
  };

  it('plays a full match and keeps the event stream consistent',async()=>{
    const user = await registerUser(current());

    const created = await request(current(),'/api/games',{token:user.token,body:{seed:2027}});
    assert.equal(created.status,201);
    const game = created.body['game'] as Record<string,unknown>;
    const gameId = String(game['id']);
    assert.equal(game['seed'],2027);

    const script = [
      {type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}},
      {type:'SET_ECONOMIC_INDICATOR',payload:{key:'gdpGrowth',value:1.8}},
      {type:'SET_FLAG',payload:{key:'taxReformSent',value:true}},
    ];
    for (const decision of script) {
      const applied = await request(current(),`/api/games/${gameId}/decisions`,{token:user.token,body:decision});
      assert.equal(applied.status,200,JSON.stringify(applied.body));
    }

    const firstTurn = await request(current(),`/api/games/${gameId}/turn`,{token:user.token,body:{days:30}});
    assert.equal(firstTurn.status,200);
    const afterFirstTurn = firstTurn.body['game'] as Record<string,unknown>;
    assert.equal(afterFirstTurn['turn'],1);
    assert.equal(afterFirstTurn['worldDate'],'2027-01-31T00:00:00.000Z');

    const save = await request(current(),`/api/games/${gameId}/saves`,{token:user.token,body:{}});
    assert.equal(save.status,201);
    const saveId = String((save.body['save'] as Record<string,unknown>)['id']);

    const secondTurn = await request(current(),`/api/games/${gameId}/turn`,{token:user.token,body:{days:60}});
    assert.equal(secondTurn.status,200);
    assert.equal((secondTurn.body['game'] as Record<string,unknown>)['turn'],2);

    const restore = await request(current(),`/api/games/${gameId}/saves/${saveId}/restore`,{token:user.token,body:{}});
    assert.equal(restore.status,200);
    const restored = restore.body['game'] as Record<string,unknown>;
    assert.equal(restored['turn'],1,'restoring must rewind the world');
    assert.equal(restored['worldDate'],'2027-01-31T00:00:00.000Z');
    assert.equal(restored['currentVersion'],7,'history must keep growing after a restore');

    const events = await request(current(),`/api/games/${gameId}/events?limit=50`,{token:user.token});
    assert.equal(events.status,200);
    const stream = events.body['events'] as readonly Record<string,unknown>[];
    assert.deepEqual(stream.map(entry => entry['type']),[
      'GameCreated','DecisionApplied','DecisionApplied','DecisionApplied','TurnAdvanced','TurnAdvanced','SaveRestored',
    ]);
    assert.deepEqual(stream.map(entry => entry['version']),[1,2,3,4,5,6,7]);

    const replay = await request(current(),`/api/games/${gameId}/replay`,{token:user.token});
    assert.equal(replay.status,200);
    const outcome = replay.body['replay'] as Record<string,unknown>;
    assert.equal(outcome['consistent'],true);
    assert.equal(outcome['checkpoints'],1);
    assert.equal(outcome['version'],7);
  });

  it('survives a cold restart: state comes back from PostgreSQL only',async()=>{
    const user = await registerUser(current());
    const created = await request(current(),'/api/games',{token:user.token,body:{seed:7}});
    const gameId = String((created.body['game'] as Record<string,unknown>)['id']);
    await request(current(),`/api/games/${gameId}/decisions`,{
      token:user.token,
      body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'selic',value:9.5}},
    });

    assert.ok(database);
    const fresh = createPostgresPersistence(persistenceOptionsFor(database.url));
    const rebooted = await startTestServer({
      persistence:fresh,
      rateLimits:{auth:{limit:10_000,windowMs:60_000},write:{limit:10_000,windowMs:60_000},read:{limit:10_000,windowMs:60_000}},
    });
    try {
      const reread = await request(rebooted,`/api/games/${gameId}`,{token:user.token});
      assert.equal(reread.status,200);
      const state = (reread.body['game'] as Record<string,unknown>)['state'] as Record<string,unknown>;
      const world = state['world'] as Record<string,unknown>;
      assert.deepEqual(world['economy'],{selic:9.5});
    } finally {
      await rebooted.close();
      await fresh.close();
    }
  });

  it('isolates players: a second account cannot touch the first match',async()=>{
    const owner = await registerUser(current());
    const created = await request(current(),'/api/games',{token:owner.token,body:{seed:11}});
    const gameId = String((created.body['game'] as Record<string,unknown>)['id']);

    const intruder = await registerUser(current());
    const read = await request(current(),`/api/games/${gameId}`,{token:intruder.token});
    assert.equal(read.status,404);
    const write = await request(current(),`/api/games/${gameId}/turn`,{token:intruder.token,body:{days:30}});
    assert.equal(write.status,404);
    const list = await request(current(),'/api/games',{token:intruder.token});
    assert.deepEqual((list.body['games'] as readonly unknown[]).length,0);
  });
});
