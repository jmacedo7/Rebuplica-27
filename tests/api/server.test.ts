import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { issueAccessToken } from '../../src/security/jwt.ts';
import {
  TEST_JWT_SECRET,
  createGame,
  registerUser,
  request,
  startTestServer,
  type TestServer,
} from '../helpers/server.ts';

const withServer=async(operation:(server:TestServer)=>Promise<void>,options:Parameters<typeof startTestServer>[0]={}):Promise<void>=>{
  const server=await startTestServer(options);
  try{await operation(server);}finally{await server.close();}
};

const errorCode=(body:Record<string,unknown>):string=>{
  const error=body['error'];
  assert.ok(typeof error==='object'&&error!==null,`expected an error envelope, received ${JSON.stringify(body)}`);
  return (error as Record<string,unknown>)['code'] as string;
};

describe('GET /health and /ready',()=>{
  it('reports liveness without touching the database',async()=>{
    await withServer(async server=>{
      const health=await request(server,'/health');
      assert.equal(health.status,200);
      assert.equal(health.body['status'],'ok');
      assert.equal(health.body['service'],'rebuplica-27');
      assert.equal(typeof health.body['uptimeSeconds'],'number');
    });
  });
  it('reports readiness including the database check',async()=>{
    await withServer(async server=>{
      const ready=await request(server,'/ready');
      assert.equal(ready.status,200);
      assert.deepEqual(ready.body['checks'],{database:'ok'});
    });
  });
  it('answers 503 when the database is unavailable',async()=>{
    const server=await startTestServer();
    try{
      // Simulate an outage without touching the HTTP layer internals.
      const persistence=server.persistence;
      Object.defineProperty(persistence,'ping',{value:async()=>{throw new Error('down');}});
      const ready=await request(server,'/ready');
      assert.equal(ready.status,503);
      assert.deepEqual(ready.body['checks'],{database:'unavailable'});
    }finally{await server.close();}
  });
  it('is not rate limited so probes keep working',async()=>{
    await withServer(async server=>{
      for(let index=0;index<20;index+=1)assert.equal((await request(server,'/health')).status,200);
    },{rateLimits:{auth:{limit:1,windowMs:60_000},write:{limit:1,windowMs:60_000},read:{limit:1,windowMs:60_000}}});
  });
});

describe('POST /auth/register',()=>{
  it('creates a user without echoing the password',async()=>{
    await withServer(async server=>{
      const response=await request(server,'/auth/register',{body:{email:'Player@Example.com',password:'a-very-strong-password'}});
      assert.equal(response.status,201);
      const user=response.body['user'] as Record<string,unknown>;
      assert.equal(user['email'],'player@example.com');
      assert.ok(typeof user['id']==='string');
      assert.ok(typeof user['createdAt']==='string');
      assert.equal(JSON.stringify(response.body).includes('a-very-strong-password'),false);
      assert.equal(JSON.stringify(response.body).includes('scrypt'),false);
    });
  });
  it('rejects a duplicate email with 409',async()=>{
    await withServer(async server=>{
      await request(server,'/auth/register',{body:{email:'dup@example.com',password:'a-very-strong-password'}});
      const duplicate=await request(server,'/auth/register',{body:{email:'DUP@example.com',password:'a-very-strong-password'}});
      assert.equal(duplicate.status,409);
      assert.equal(errorCode(duplicate.body),'EMAIL_ALREADY_EXISTS');
    });
  });
  it('rejects weak passwords, invalid emails and unknown fields',async()=>{
    await withServer(async server=>{
      const weak=await request(server,'/auth/register',{body:{email:'weak@example.com',password:'short'}});
      assert.equal(weak.status,400);
      assert.equal(errorCode(weak.body),'WEAK_PASSWORD');
      const invalid=await request(server,'/auth/register',{body:{email:'not-an-email',password:'a-very-strong-password'}});
      assert.equal(invalid.status,400);
      assert.equal(errorCode(invalid.body),'INVALID_EMAIL');
      const extra=await request(server,'/auth/register',{body:{email:'x@example.com',password:'a-very-strong-password',role:'admin'}});
      assert.equal(extra.status,400);
      assert.equal(errorCode(extra.body),'VALIDATION_ERROR');
      assert.match(JSON.stringify(extra.body),/role/u);
    });
  });
  it('rejects malformed JSON and oversized bodies',async()=>{
    await withServer(async server=>{
      const malformed=await request(server,'/auth/register',{rawBody:'{"email":'});
      assert.equal(malformed.status,400);
      assert.equal(errorCode(malformed.body),'VALIDATION_ERROR');
      const oversized=await request(server,'/auth/register',{rawBody:JSON.stringify({email:'a@b.co',password:'x'.repeat(2_000)})});
      assert.equal(oversized.status,413);
      assert.equal(errorCode(oversized.body),'PAYLOAD_TOO_LARGE');
    },{bodyLimitBytes:512});
  });
  it('rejects a body that is not JSON',async()=>{
    await withServer(async server=>{
      const response=await request(server,'/auth/register',{
        method:'POST',
        rawBody:'email=a@b.co&password=x',
        headers:{'content-type':'application/x-www-form-urlencoded'},
      });
      assert.equal(response.status,415);
      assert.equal(errorCode(response.body),'UNSUPPORTED_MEDIA_TYPE');
    });
  });
});

describe('POST /auth/login and GET /auth/me',()=>{
  it('logs in and returns a bearer token that identifies the user',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const me=await request(server,'/auth/me',{token:user.token});
      assert.equal(me.status,200);
      assert.equal((me.body['user'] as Record<string,unknown>)['id'],user.id);
      const login=await request(server,'/auth/login',{body:{email:user.email,password:'a-very-strong-password'}});
      assert.equal(login.status,200);
      assert.equal(login.body['tokenType'],'Bearer');
      assert.equal(login.body['expiresIn'],900);
    });
  });
  it('does not reveal whether the account exists',async()=>{
    await withServer(async server=>{
      await registerUser(server);
      const wrongPassword=await request(server,'/auth/login',{body:{email:'unknown-player@example.com',password:'a-very-strong-password'}});
      assert.equal(wrongPassword.status,401);
      assert.equal(errorCode(wrongPassword.body),'UNAUTHORIZED');
      assert.deepEqual(wrongPassword.body['error'],(await request(server,'/auth/login',{body:{email:'missing@example.com',password:'a-very-strong-password'}})).body['error']);
    });
  });
  it('requires a valid, correctly signed and unexpired token',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      assert.equal((await request(server,'/auth/me')).status,401);
      assert.equal((await request(server,'/auth/me',{token:'not-a-token'})).status,401);
      assert.equal((await request(server,'/auth/me',{token:`${user.token}x`})).status,401);
      const wrongSecret=issueAccessToken(user.id,'another-secret-that-is-long-enough','rebuplica-27','rebuplica-api',900);
      assert.equal((await request(server,'/auth/me',{token:wrongSecret})).status,401);
      const expired=issueAccessToken(user.id,TEST_JWT_SECRET,'rebuplica-27','rebuplica-api',900,Math.floor(Date.now()/1000)-1000);
      assert.equal((await request(server,'/auth/me',{token:expired})).status,401);
      const wrongAudience=issueAccessToken(user.id,TEST_JWT_SECRET,'rebuplica-27','other-api',900);
      assert.equal((await request(server,'/auth/me',{token:wrongAudience})).status,401);
    });
  });
  it('rejects a token for a user that no longer exists',async()=>{
    await withServer(async server=>{
      const orphan=issueAccessToken('9f1c1d5e-0000-4000-8000-000000000000',TEST_JWT_SECRET,'rebuplica-27','rebuplica-api',900);
      const response=await request(server,'/auth/me',{token:orphan});
      assert.equal(response.status,401);
    });
  });
});

describe('games',()=>{
  it('creates, lists and reads a game for its owner',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token,1234);
      assert.equal(game['seed'],1234);
      assert.equal(game['turn'],0);
      assert.equal(game['currentVersion'],1);
      const detail=await request(server,`/games/${String(game['id'])}`,{token:user.token});
      assert.equal(detail.status,200);
      const state=(detail.body['game'] as Record<string,unknown>)['state'] as Record<string,unknown>;
      assert.equal(state['ownerId'],user.id);
      const list=await request(server,'/games',{token:user.token});
      assert.equal(list.status,200);
      assert.equal((list.body['page'] as Record<string,unknown>)['total'],1);
      assert.equal((list.body['games'] as unknown[]).length,1);
    });
  });
  it('generates a seed when none is provided and validates the given one',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      assert.equal(typeof game['seed'],'number');
      const invalid=await request(server,'/games',{token:user.token,body:{seed:-1}});
      assert.equal(invalid.status,400);
      const unknown=await request(server,'/games',{token:user.token,body:{difficulty:'easy'}});
      assert.equal(unknown.status,400);
      assert.match(JSON.stringify(unknown.body),/difficulty/u);
    });
  });
  it('paginates the owner listing',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      for(let index=0;index<3;index+=1)await createGame(server,user.token,index+1);
      const page=await request(server,'/games?limit=2&offset=0',{token:user.token});
      assert.equal((page.body['games'] as unknown[]).length,2);
      assert.equal((page.body['page'] as Record<string,unknown>)['total'],3);
      const invalid=await request(server,'/games?limit=500',{token:user.token});
      assert.equal(invalid.status,400);
    });
  });
  it('validates the game id',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      assert.equal((await request(server,'/games/not-a-uuid',{token:user.token})).status,400);
      assert.equal((await request(server,`/games/${'0'.repeat(8)}-0000-4000-8000-000000000000`,{token:user.token})).status,404);
    });
  });
  it('never exposes another user game (IDOR)',async()=>{
    await withServer(async server=>{
      const owner=await registerUser(server);
      const attacker=await registerUser(server);
      const game=await createGame(server,owner.token);
      const gameId=String(game['id']);
      for(const path of [`/games/${gameId}`,`/games/${gameId}/events`,`/games/${gameId}/replay`,`/games/${gameId}/saves`]){
        const response=await request(server,path,{token:attacker.token});
        assert.equal(response.status,404,`${path} leaked another user game`);
      }
      const decision=await request(server,`/games/${gameId}/decisions`,{token:attacker.token,body:{type:'SET_FLAG',payload:{key:'x',value:true}}});
      assert.equal(decision.status,404);
      const turn=await request(server,`/games/${gameId}/turn`,{token:attacker.token,body:{}});
      assert.equal(turn.status,404);
      const save=await request(server,`/games/${gameId}/saves`,{token:attacker.token,body:{}});
      assert.equal(save.status,404);
      const stillOwned=await request(server,`/games/${gameId}`,{token:owner.token});
      assert.equal(stillOwned.status,200);
      assert.equal((stillOwned.body['game'] as Record<string,unknown>)['currentVersion'],1);
      const attackerList=await request(server,'/games',{token:attacker.token});
      assert.equal((attackerList.body['page'] as Record<string,unknown>)['total'],0);
    });
  });
  it('refuses a save that belongs to another game (IDOR on saves)',async()=>{
    await withServer(async server=>{
      const owner=await registerUser(server);
      const attacker=await registerUser(server);
      const ownerGame=await createGame(server,owner.token,1);
      const attackerGame=await createGame(server,attacker.token,2);
      const save=await request(server,`/games/${String(ownerGame['id'])}/saves`,{token:owner.token,body:{}});
      assert.equal(save.status,201);
      const saveId=((save.body['save'] as Record<string,unknown>)['id']) as string;
      const crossGame=await request(server,`/games/${String(attackerGame['id'])}/saves/${saveId}/restore`,{token:attacker.token,body:{}});
      assert.equal(crossGame.status,404);
      const crossOwner=await request(server,`/games/${String(ownerGame['id'])}/saves/${saveId}/restore`,{token:attacker.token,body:{}});
      assert.equal(crossOwner.status,404);
    });
  });
});

describe('gameplay',()=>{
  it('applies a decision, advances the version and returns the new state',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token,7);
      const applied=await request(server,`/games/${String(game['id'])}/decisions`,{token:user.token,body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}}});
      assert.equal(applied.status,200);
      const updated=applied.body['game'] as Record<string,unknown>;
      assert.equal(updated['currentVersion'],2);
      const state=updated['state'] as Record<string,unknown>;
      assert.deepEqual((state['world'] as Record<string,unknown>)['economy'],{inflation:4.2});
    });
  });
  it('rejects unknown decision types and invalid payloads with 400',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      const unknown=await request(server,`/games/${String(game['id'])}/decisions`,{token:user.token,body:{type:'DROP_TABLE',payload:{}}});
      assert.equal(unknown.status,400);
      assert.equal(errorCode(unknown.body),'VALIDATION_ERROR');
      const invalidPayload=await request(server,`/games/${String(game['id'])}/decisions`,{token:user.token,body:{type:'SET_FLAG',payload:{key:'flag',value:'yes'}}});
      assert.equal(invalidPayload.status,400);
      const hostile=await request(server,`/games/${String(game['id'])}/decisions`,{token:user.token,body:{type:'SET_FLAG',payload:{key:'__proto__',value:true}}});
      assert.equal(hostile.status,400);
    });
  });
  it('advances turns and validates the duration',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      const advanced=await request(server,`/games/${String(game['id'])}/turn`,{token:user.token,body:{days:15}});
      assert.equal(advanced.status,200);
      const updated=advanced.body['game'] as Record<string,unknown>;
      assert.equal(updated['turn'],1);
      assert.equal(updated['worldDate'],'2027-01-16T00:00:00.000Z');
      const defaultDays=await request(server,`/games/${String(game['id'])}/turn`,{token:user.token,body:{}});
      assert.equal((defaultDays.body['game'] as Record<string,unknown>)['worldDate'],'2027-02-15T00:00:00.000Z');
      for(const body of [{days:0},{days:-1},{days:99999},{days:'30'},{turn:2}]){
        const response=await request(server,`/games/${String(game['id'])}/turn`,{token:user.token,body});
        assert.equal(response.status,400,JSON.stringify(body));
      }
    });
  });
  it('lists the event history in order with pagination and filtering',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      const gameId=String(game['id']);
      await request(server,`/games/${gameId}/decisions`,{token:user.token,body:{type:'SET_FLAG',payload:{key:'declared',value:true}}});
      await request(server,`/games/${gameId}/turn`,{token:user.token,body:{days:30}});
      const events=await request(server,`/games/${gameId}/events`,{token:user.token});
      assert.equal(events.status,200);
      assert.deepEqual((events.body['events'] as Record<string,unknown>[]).map(event=>event['type']),['GameCreated','DecisionApplied','TurnAdvanced']);
      assert.deepEqual((events.body['events'] as Record<string,unknown>[]).map(event=>event['version']),[1,2,3]);
      assert.ok((events.body['events'] as Record<string,unknown>[]).every(event=>typeof event['recordedAt']==='string'));
      const filtered=await request(server,`/games/${gameId}/events?afterVersion=2`,{token:user.token});
      assert.deepEqual((filtered.body['events'] as Record<string,unknown>[]).map(event=>event['version']),[3]);
      const limited=await request(server,`/games/${gameId}/events?limit=1`,{token:user.token});
      assert.equal((limited.body['events'] as unknown[]).length,1);
      assert.equal((limited.body['page'] as Record<string,unknown>)['total'],3);
      const badFilter=await request(server,`/games/${gameId}/events?afterVersion=nope`,{token:user.token});
      assert.equal(badFilter.status,400);
    });
  });
  it('proves the event stream replays to the stored state',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token,99);
      const gameId=String(game['id']);
      await request(server,`/games/${gameId}/decisions`,{token:user.token,body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'gdp',value:2.5}}});
      await request(server,`/games/${gameId}/turn`,{token:user.token,body:{days:30}});
      const replay=await request(server,`/games/${gameId}/replay`,{token:user.token});
      assert.equal(replay.status,200);
      const outcome=replay.body['replay'] as Record<string,unknown>;
      assert.equal(outcome['consistent'],true);
      assert.equal(outcome['version'],3);
      assert.equal(outcome['events'],3);
      assert.equal(typeof outcome['fingerprint'],'string');
    });
  });
});

describe('saves and restore',()=>{
  it('saves the current version, lists it and restores it transactionally',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token,5);
      const gameId=String(game['id']);
      await request(server,`/games/${gameId}/decisions`,{token:user.token,body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}}});
      const saved=await request(server,`/games/${gameId}/saves`,{token:user.token,body:{}});
      assert.equal(saved.status,201);
      const save=saved.body['save'] as Record<string,unknown>;
      assert.equal(save['version'],2);
      assert.equal(save['schemaVersion'],1);

      await request(server,`/games/${gameId}/turn`,{token:user.token,body:{days:30}});
      await request(server,`/games/${gameId}/decisions`,{token:user.token,body:{type:'SET_FLAG',payload:{key:'after_save',value:true}}});
      const beforeRestore=await request(server,`/games/${gameId}`,{token:user.token});
      assert.equal((beforeRestore.body['game'] as Record<string,unknown>)['turn'],1);

      const restored=await request(server,`/games/${gameId}/saves/${String(save['id'])}/restore`,{token:user.token,body:{}});
      assert.equal(restored.status,200);
      const afterRestore=restored.body['game'] as Record<string,unknown>;
      assert.equal(afterRestore['turn'],0);
      assert.equal(afterRestore['currentVersion'],5);
      const state=afterRestore['state'] as Record<string,unknown>;
      assert.deepEqual((state['world'] as Record<string,unknown>)['economy'],{inflation:4.2});
      assert.deepEqual((state['world'] as Record<string,unknown>)['flags'],{});

      // History is preserved and the replay still holds after a rewind.
      const events=await request(server,`/games/${gameId}/events`,{token:user.token});
      assert.deepEqual((events.body['events'] as Record<string,unknown>[]).map(event=>event['type']),['GameCreated','DecisionApplied','TurnAdvanced','DecisionApplied','SaveRestored']);
      const replay=await request(server,`/games/${gameId}/replay`,{token:user.token});
      assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);
      assert.equal((replay.body['replay'] as Record<string,unknown>)['checkpoints'],1);

      const saves=await request(server,`/games/${gameId}/saves`,{token:user.token});
      assert.equal((saves.body['saves'] as unknown[]).length,1);
      assert.equal((saves.body['page'] as Record<string,unknown>)['total'],1);
    });
  });
  it('refuses a second save for the same version',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      const gameId=String(game['id']);
      assert.equal((await request(server,`/games/${gameId}/saves`,{token:user.token,body:{}})).status,201);
      const duplicate=await request(server,`/games/${gameId}/saves`,{token:user.token,body:{}});
      assert.equal(duplicate.status,409);
      assert.equal(errorCode(duplicate.body),'SAVE_CONFLICT');
    });
  });
  it('answers 404 for an unknown or malformed save id',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const game=await createGame(server,user.token);
      const gameId=String(game['id']);
      assert.equal((await request(server,`/games/${gameId}/saves/00000000-0000-4000-8000-000000000000/restore`,{token:user.token,body:{}})).status,404);
      assert.equal((await request(server,`/games/${gameId}/saves/nope/restore`,{token:user.token,body:{}})).status,400);
    });
  });
});

describe('routing and protocol level behaviour',()=>{
  it('answers 404 for unknown routes and 405 for a wrong method',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      assert.equal((await request(server,'/nope',{token:user.token})).status,404);
      const wrongMethod=await request(server,'/auth/login',{method:'GET',token:user.token});
      assert.equal(wrongMethod.status,405);
      assert.equal(wrongMethod.headers.get('allow'),'POST');
      assert.equal((await request(server,'/games/abc',{method:'POST',token:user.token})).status,405);
    });
  });
  it('rejects a malformed URL encoding as a client error',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const malformed=await request(server,'/games/%zz',{token:user.token});
      assert.equal(malformed.status,400);
      assert.equal(errorCode(malformed.body),'VALIDATION_ERROR');
      const badQuery=await request(server,'/games?limit=%zz',{token:user.token});
      assert.equal(badQuery.status,400);
    });
  });
  it('sets the documented security headers on every response',async()=>{
    await withServer(async server=>{
      const response=await request(server,'/health');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.equal(response.headers.get('x-frame-options'),'DENY');
      assert.equal(response.headers.get('referrer-policy'),'no-referrer');
      assert.match(response.headers.get('content-security-policy') ?? '',/frame-ancestors 'none'/u);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
    });
  });
  it('echoes a safe request id and generates one otherwise',async()=>{
    await withServer(async server=>{
      const echoed=await request(server,'/health',{headers:{'x-request-id':'client-12345'}});
      assert.equal(echoed.headers.get('x-request-id'),'client-12345');
      const generated=await request(server,'/health',{headers:{'x-request-id':'<script>alert(1)</script>'}});
      const value=generated.headers.get('x-request-id') ?? '';
      assert.notEqual(value,'<script>alert(1)</script>');
      assert.match(value,/^[0-9a-f-]{36}$/u);
      const body=await request(server,'/nope');
      assert.equal(typeof body.body['requestId'],'string');
    });
  });
  it('rejects unsupported methods and origins on state changing requests',async()=>{
    await withServer(async server=>{
      const user=await registerUser(server);
      const blocked=await request(server,'/games',{token:user.token,body:{},origin:'https://evil.example'});
      assert.equal(blocked.status,403);
      assert.equal(errorCode(blocked.body),'FORBIDDEN');
    },{corsAllowedOrigins:['https://app.example']});
  });
  it('answers CORS preflight only for configured origins',async()=>{
    await withServer(async server=>{
      const allowed=await request(server,'/games',{method:'OPTIONS',origin:'https://app.example',headers:{'access-control-request-method':'POST'}});
      assert.equal(allowed.status,204);
      assert.equal(allowed.headers.get('access-control-allow-origin'),'https://app.example');
      assert.match(allowed.headers.get('access-control-allow-headers') ?? '',/authorization/u);
      assert.equal(allowed.headers.get('vary'),'Origin');
      const denied=await request(server,'/games',{method:'OPTIONS',origin:'https://evil.example'});
      assert.equal(denied.status,403);
      assert.equal(denied.headers.get('access-control-allow-origin'),null);
    },{corsAllowedOrigins:['https://app.example']});
  });
  it('rate limits the auth scope with a retry-after header',async()=>{
    const limits={auth:{limit:3,windowMs:60_000},write:{limit:2,windowMs:60_000},read:{limit:100,windowMs:60_000}};
    await withServer(async server=>{
      for(let index=0;index<3;index+=1){
        const attempt=await request(server,'/auth/login',{body:{email:'nobody@example.com',password:'a-very-strong-password'}});
        assert.equal(attempt.status,401);
      }
      const limited=await request(server,'/auth/login',{body:{email:'nobody@example.com',password:'a-very-strong-password'}});
      assert.equal(limited.status,429);
      assert.equal(errorCode(limited.body),'RATE_LIMITED');
      assert.ok(Number(limited.headers.get('retry-after'))>=1);
      assert.equal(limited.headers.get('x-ratelimit-remaining'),'0');
      // Reads have their own budget, so the frontend can still load the game list.
      const read=await request(server,'/health');
      assert.equal(read.status,200);
    },{rateLimits:limits});
  });
  it('counts each client separately when a trusted proxy reports the address',async()=>{
    await withServer(async server=>{
      const first=await request(server,'/auth/login',{body:{},headers:{'x-forwarded-for':'203.0.113.10'}});
      assert.equal(first.status,400);
      const second=await request(server,'/auth/login',{body:{},headers:{'x-forwarded-for':'203.0.113.11'}});
      assert.equal(second.status,400);
    },{rateLimits:{auth:{limit:1,windowMs:60_000},write:{limit:1,windowMs:60_000},read:{limit:1,windowMs:60_000}},trustedProxyHops:1});
  });
  it('never returns internal details for unexpected failures',async()=>{
    await withServer(async server=>{
      const persistence=server.persistence;
      Object.defineProperty(persistence,'games',{value:{...persistence.games,findById:async()=>{throw new Error('connection string postgres://user:secret@host/db');}}});
      const user=await registerUser(server);
      const response=await request(server,'/games/00000000-0000-4000-8000-000000000000',{token:user.token});
      assert.equal(response.status,500);
      const serialised=JSON.stringify(response.body);
      assert.ok(!serialised.includes('postgres://'),'internal details leaked');
      assert.ok(!serialised.includes('secret'),'internal details leaked');
      assert.equal(errorCode(response.body),'INTERNAL_ERROR');
    });
  });
});
