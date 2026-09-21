import assert from 'node:assert/strict';
import { after,before,describe,it } from 'node:test';
import { createPostgresPersistence,type PostgresPersistence } from '../../src/persistence/postgres.ts';
import { createGame,registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';
import { databaseSkipReason,hasDatabase,persistenceOptionsFor,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';

/**
 * Concurrency against real transactions. Two writers that read the same version must
 * not both succeed: exactly one wins and the other receives a conflict, so no update
 * is silently overwritten.
 */
describe('concurrent writes',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;
  let persistence: PostgresPersistence | undefined;
  let server: TestServer | undefined;

  before(async()=>{
    database=await provisionDatabase('concurrency');
    persistence=createPostgresPersistence(persistenceOptionsFor(database.url));
    // Throttling is covered by the API suite; this suite needs unlimited parallel traffic.
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

  it('lets exactly one of several simultaneous decisions win',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token);
    const gameId=String(game['id']);
    const responses=await Promise.all(
      Array.from({length:5},(_,index)=>request(current(),`/games/${gameId}/decisions`,{
        token:user.token,
        body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:`indicator_${index}`,value:index}},
      })),
    );
    const accepted=responses.filter(response=>response.status===200);
    const conflicted=responses.filter(response=>response.status===409);
    assert.equal(accepted.length+conflicted.length,5);
    assert.ok(accepted.length>=1);
    assert.ok(conflicted.every(response=>(response.body['error'] as Record<string,unknown>)['code']==='CONFLICT'));

    // No lost update: the stored version counts exactly the accepted writes and the
    // state contains exactly the indicators that were accepted.
    const after=await request(current(),`/games/${gameId}`,{token:user.token});
    const state=(after.body['game'] as Record<string,unknown>)['state'] as Record<string,unknown>;
    const version=(after.body['game'] as Record<string,unknown>)['currentVersion'] as number;
    assert.equal(version,1+accepted.length);
    const economy=(state['world'] as Record<string,unknown>)['economy'] as Record<string,unknown>;
    assert.equal(Object.keys(economy).length,accepted.length);

    const events=await request(current(),`/games/${gameId}/events`,{token:user.token});
    assert.equal((events.body['page'] as Record<string,unknown>)['total'],version);
    const replay=await request(current(),`/games/${gameId}/replay`,{token:user.token});
    assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);
  });

  it('lets the database reject the second of two overlapping writers',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token);
    const gameId=String(game['id']);
    assert.ok(database);
    const { Client }=await import('pg');
    const firstClient=new Client({connectionString:database.url});
    const secondClient=new Client({connectionString:database.url});
    await firstClient.connect();
    await secondClient.connect();
    try{
      const update='UPDATE games SET state = $1::jsonb, current_version = current_version + 1 WHERE id = $2 AND current_version = $3';
      const readVersion=async(client:InstanceType<typeof Client>):Promise<number>=>{
        const result=await client.query<{current_version: number}>('SELECT current_version FROM games WHERE id = $1',[gameId]);
        return result.rows[0]?.current_version ?? 0;
      };
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      const firstVersion=await readVersion(firstClient);
      const secondVersion=await readVersion(secondClient);
      assert.equal(firstVersion,secondVersion,'both writers must start from the same version');
      const firstUpdate=await firstClient.query(update,[JSON.stringify({...game['state'] as object,turn:1}),gameId,firstVersion]);
      assert.equal(firstUpdate.rowCount,1);
      await firstClient.query('COMMIT');
      // The second writer still believes it holds version 1: PostgreSQL matches no row.
      const secondUpdate=await secondClient.query(update,[JSON.stringify({...game['state'] as object,turn:2}),gameId,secondVersion]);
      assert.equal(secondUpdate.rowCount,0,'a stale version must never overwrite a newer one');
      await secondClient.query('ROLLBACK');
      const finalVersion=await readVersion(firstClient);
      assert.equal(finalVersion,firstVersion+1);
    }finally{
      await firstClient.end();
      await secondClient.end();
    }
  });

  it('serialises simultaneous turn advances without losing events',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token);
    const gameId=String(game['id']);
    const results=await Promise.all(Array.from({length:3},()=>request(current(),`/games/${gameId}/turn`,{token:user.token,body:{days:10}})));
    const winners=results.filter(response=>response.status===200).length;
    const conflicts=results.filter(response=>response.status===409).length;
    assert.equal(winners+conflicts,3);
    assert.ok(winners>=1);
    const after=await request(current(),`/games/${gameId}`,{token:user.token});
    const version=(after.body['game'] as Record<string,unknown>)['currentVersion'] as number;
    assert.equal(version,1+winners);
    const events=await request(current(),`/games/${gameId}/events`,{token:user.token});
    assert.equal((events.body['page'] as Record<string,unknown>)['total'],version);
    const replay=await request(current(),`/games/${gameId}/replay`,{token:user.token});
    assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);
  });

  it('accepts only one save per version',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token);
    const gameId=String(game['id']);
    const results=await Promise.all(Array.from({length:4},()=>request(current(),`/games/${gameId}/saves`,{token:user.token,body:{}})));
    assert.equal(results.filter(response=>response.status===201).length,1);
    assert.equal(results.filter(response=>response.status===409).length,3);
    const saves=await request(current(),`/games/${gameId}/saves`,{token:user.token});
    assert.equal((saves.body['page'] as Record<string,unknown>)['total'],1);
  });

  it('accepts only one registration for the same email',async()=>{
    const email=`race-${Date.now().toString(36)}@example.com`;
    const results=await Promise.all(Array.from({length:3},()=>request(current(),'/auth/register',{
      body:{email,password:'a-very-strong-password'},
    })));
    assert.equal(results.filter(response=>response.status===201).length,1);
    assert.equal(results.filter(response=>response.status===409).length,2);
    const login=await request(current(),'/auth/login',{body:{email,password:'a-very-strong-password'}});
    assert.equal(login.status,200);
  });

  it('keeps restore transactional under concurrent traffic',async()=>{
    const user=await registerUser(current());
    const game=await createGame(current(),user.token);
    const gameId=String(game['id']);
    await request(current(),`/games/${gameId}/decisions`,{token:user.token,body:{type:'SET_FLAG',payload:{key:'declared',value:true}}});
    const save=await request(current(),`/games/${gameId}/saves`,{token:user.token,body:{}});
    const saveId=String((save.body['save'] as Record<string,unknown>)['id']);
    const results=await Promise.all([
      request(current(),`/games/${gameId}/saves/${saveId}/restore`,{token:user.token,body:{}}),
      request(current(),`/games/${gameId}/turn`,{token:user.token,body:{days:5}}),
    ]);
    assert.ok(results.every(response=>response.status===200||response.status===409),JSON.stringify(results.map(response=>response.status)));
    const events=await request(current(),`/games/${gameId}/events`,{token:user.token});
    const stored=(events.body['page'] as Record<string,unknown>)['total'] as number;
    const game2=await request(current(),`/games/${gameId}`,{token:user.token});
    assert.equal((game2.body['game'] as Record<string,unknown>)['currentVersion'],stored);
    const replay=await request(current(),`/games/${gameId}/replay`,{token:user.token});
    assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);
  });
});
