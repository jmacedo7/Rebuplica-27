import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { createGame,registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';

/**
 * Contract test: every route documented in `docs/07-API.md` must exist, answer on
 * both the bare path and the `/api` prefix used by the ingress, and return the
 * documented envelope (keys, pagination block, error codes). It is the frontend's
 * safety net: breaking the shape breaks this file.
 */

const NO_RATE_LIMITS = {
  rateLimits:{auth:{limit:10_000,windowMs:60_000},write:{limit:10_000,windowMs:60_000},read:{limit:10_000,windowMs:60_000}},
} as const;

const withServer = async (operation:(server:TestServer)=>Promise<void>):Promise<void> => {
  const server = await startTestServer(NO_RATE_LIMITS);
  try { await operation(server); } finally { await server.close(); }
};

const record = (value:unknown,label:string):Record<string,unknown> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value),`${label} must be an object, received ${JSON.stringify(value)}`);
  return value as Record<string,unknown>;
};

const errorCode = (body:Record<string,unknown>):string => String(record(body['error'],'error')['code']);

const assertPage = (body:Record<string,unknown>):void => {
  const page = record(body['page'],'page');
  assert.equal(typeof page['limit'],'number');
  assert.equal(typeof page['offset'],'number');
  assert.equal(typeof page['total'],'number');
};

const assertGameShape = (value:unknown):Record<string,unknown> => {
  const game = record(value,'game');
  for (const key of ['id','seed','turn','currentVersion','worldDate','createdAt','updatedAt','state']) {
    assert.ok(key in game,`game is missing "${key}"`);
  }
  const state = record(game['state'],'game.state');
  for (const key of ['gameId','ownerId','seed','turn','world']) assert.ok(key in state,`game.state is missing "${key}"`);
  const world = record(state['world'],'game.state.world');
  for (const key of ['date','economy','society','institutions','flags']) assert.ok(key in world,`world is missing "${key}"`);
  return game;
};

describe('API contract: monitoring',()=>{
  it('serves /health and /ready without auth, on both prefixes',async()=>{
    await withServer(async server => {
      for (const prefix of ['','/api']) {
        const health = await request(server,`${prefix}/health`);
        assert.equal(health.status,200,`${prefix}/health`);
        assert.equal(health.body['status'],'ok');
        const ready = await request(server,`${prefix}/ready`);
        assert.equal(ready.status,200,`${prefix}/ready`);
        assert.deepEqual(ready.body['checks'],{database:'ok'});
      }
    });
  });
});

describe('API contract: authentication',()=>{
  it('registers, logs in and identifies the user',async()=>{
    await withServer(async server => {
      const email = `contract-${Date.now().toString(36)}@example.com`;
      const password = 'a-very-strong-password';
      const registered = await request(server,'/api/auth/register',{body:{email,password}});
      assert.equal(registered.status,201);
      const user = record(registered.body['user'],'user');
      assert.equal(user['email'],email);
      assert.equal(typeof user['id'],'string');
      assert.equal(typeof user['createdAt'],'string');
      assert.ok(!('passwordHash' in user),'register must never leak the password hash');

      const duplicate = await request(server,'/api/auth/register',{body:{email,password}});
      assert.equal(duplicate.status,409);
      assert.equal(errorCode(duplicate.body),'EMAIL_ALREADY_EXISTS');

      const weak = await request(server,'/api/auth/register',{body:{email:`w-${email}`,password:'short'}});
      assert.equal(weak.status,400);
      assert.equal(errorCode(weak.body),'WEAK_PASSWORD');

      const login = await request(server,'/api/auth/login',{body:{email,password}});
      assert.equal(login.status,200);
      assert.equal(login.body['tokenType'],'Bearer');
      assert.equal(typeof login.body['accessToken'],'string');
      assert.equal(typeof login.body['expiresIn'],'number');

      const wrong = await request(server,'/api/auth/login',{body:{email,password:'a-very-wrong-password'}});
      assert.equal(wrong.status,401);
      assert.equal(errorCode(wrong.body),'UNAUTHORIZED');

      const me = await request(server,'/api/auth/me',{token:String(login.body['accessToken'])});
      assert.equal(me.status,200);
      assert.equal(record(me.body['user'],'user')['email'],email);

      const anonymous = await request(server,'/api/auth/me');
      assert.equal(anonymous.status,401);
      assert.equal(errorCode(anonymous.body),'UNAUTHORIZED');
    });
  });
});

describe('API contract: games',()=>{
  it('creates, lists and reads a game with the documented shape',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const created = await request(server,'/api/games',{token:user.token,body:{seed:4242}});
      assert.equal(created.status,201);
      const game = assertGameShape(created.body['game']);
      assert.equal(game['seed'],4242);
      assert.equal(game['turn'],0);
      assert.equal(game['currentVersion'],1);

      const list = await request(server,'/api/games',{token:user.token});
      assert.equal(list.status,200);
      assert.ok(Array.isArray(list.body['games']));
      assertPage(list.body);

      const read = await request(server,`/api/games/${String(game['id'])}`,{token:user.token});
      assert.equal(read.status,200);
      assertGameShape(read.body['game']);

      const badId = await request(server,'/api/games/not-a-uuid',{token:user.token});
      assert.equal(badId.status,400);

      const other = await registerUser(server);
      const foreign = await request(server,`/api/games/${String(game['id'])}`,{token:other.token});
      assert.equal(foreign.status,404,'another user must not see the game');
      assert.equal(errorCode(foreign.body),'NOT_FOUND');
    });
  });
});

describe('API contract: gameplay, history and saves',()=>{
  it('applies decisions, advances turns and exposes events and replay',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const game = await createGame(server,user.token,99);
      const gameId = String(game['id']);

      const decision = await request(server,`/api/games/${gameId}/decisions`,{
        token:user.token,
        body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}},
      });
      assert.equal(decision.status,200);
      const afterDecision = assertGameShape(decision.body['game']);
      assert.equal(afterDecision['currentVersion'],2);
      assert.equal(record(record(afterDecision['state'],'state')['world'],'world')['economy']?.constructor,Object);

      const flag = await request(server,`/api/games/${gameId}/decisions`,{
        token:user.token,
        body:{type:'SET_FLAG',payload:{key:'reformSent',value:true}},
      });
      assert.equal(flag.status,200);

      const invalid = await request(server,`/api/games/${gameId}/decisions`,{
        token:user.token,
        body:{type:'NOT_A_DECISION',payload:{}},
      });
      assert.equal(invalid.status,400);
      assert.ok(['INVALID_DECISION','VALIDATION_ERROR'].includes(errorCode(invalid.body)),errorCode(invalid.body));

      const turn = await request(server,`/api/games/${gameId}/turn`,{token:user.token,body:{days:30}});
      assert.equal(turn.status,200);
      const advanced = assertGameShape(turn.body['game']);
      assert.equal(advanced['turn'],1);
      assert.equal(advanced['currentVersion'],4);

      const badTurn = await request(server,`/api/games/${gameId}/turn`,{token:user.token,body:{days:0}});
      assert.equal(badTurn.status,400);

      const events = await request(server,`/api/games/${gameId}/events`,{token:user.token});
      assert.equal(events.status,200);
      const list = events.body['events'];
      assert.ok(Array.isArray(list));
      assertPage(events.body);
      assert.deepEqual(list.map(entry => record(entry,'event')['type']),['GameCreated','DecisionApplied','DecisionApplied','TurnAdvanced']);
      for (const entry of list) {
        const event = record(entry,'event');
        for (const key of ['version','type','eventId','recordedAt','event']) assert.ok(key in event,`event is missing "${key}"`);
      }

      const replay = await request(server,`/api/games/${gameId}/replay`,{token:user.token});
      assert.equal(replay.status,200);
      const outcome = record(replay.body['replay'],'replay');
      assert.equal(outcome['consistent'],true);
      assert.equal(outcome['firstMismatchVersion'],null);
      assert.equal(typeof outcome['fingerprint'],'string');

      const save = await request(server,`/api/games/${gameId}/saves`,{token:user.token,body:{}});
      assert.equal(save.status,201);
      const created = record(save.body['save'],'save');
      for (const key of ['id','version','schemaVersion','turn','worldDate','createdAt']) assert.ok(key in created,`save is missing "${key}"`);

      const duplicate = await request(server,`/api/games/${gameId}/saves`,{token:user.token,body:{}});
      assert.equal(duplicate.status,409);
      assert.equal(errorCode(duplicate.body),'SAVE_CONFLICT');

      const saves = await request(server,`/api/games/${gameId}/saves`,{token:user.token});
      assert.equal(saves.status,200);
      assert.ok(Array.isArray(saves.body['saves']));
      assertPage(saves.body);

      const restore = await request(server,`/api/games/${gameId}/saves/${String(created['id'])}/restore`,{token:user.token,body:{}});
      assert.equal(restore.status,200);
      assertGameShape(restore.body['game']);
      assert.equal(record(restore.body['save'],'save')['version'],created['version']);

      const afterRestore = await request(server,`/api/games/${gameId}/replay`,{token:user.token});
      assert.equal(record(afterRestore.body['replay'],'replay')['consistent'],true);
    });
  });
});

describe('API contract: protocol errors',()=>{
  it('answers 404, 405, 415 and 401 as documented',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);

      const missing = await request(server,'/api/does-not-exist',{token:user.token});
      assert.equal(missing.status,404);
      assert.equal(errorCode(missing.body),'NOT_FOUND');

      const wrongMethod = await request(server,'/api/health',{method:'DELETE'});
      assert.equal(wrongMethod.status,405);
      assert.equal(errorCode(wrongMethod.body),'METHOD_NOT_ALLOWED');
      assert.ok(wrongMethod.headers.get('allow'),'405 must advertise Allow');

      const notJson = await request(server,'/api/games',{
        token:user.token,
        rawBody:'seed=1',
        headers:{'content-type':'text/plain'},
      });
      assert.equal(notJson.status,415);
      assert.equal(errorCode(notJson.body),'UNSUPPORTED_MEDIA_TYPE');

      const unauthenticated = await request(server,'/api/games');
      assert.equal(unauthenticated.status,401);

      assert.ok(missing.headers.get('x-request-id'),'every response must carry X-Request-Id');
      assert.equal(missing.headers.get('x-content-type-options'),'nosniff');
      assert.equal(missing.headers.get('cache-control'),'no-store');
    });
  });
});
