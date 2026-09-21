import assert from 'node:assert/strict';
import { spawn,type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after,before,describe,it } from 'node:test';
import { databaseSkipReason,hasDatabase,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';
import { freePort } from '../helpers/server.ts';

const ENTRY_POINT=fileURLToPath(new URL('../../src/main.ts',import.meta.url));
const REPOSITORY_ROOT=fileURLToPath(new URL('../../',import.meta.url));

interface RunningServer {
  readonly port: number;
  readonly logs: string[];
  stop(): Promise<number | null>;
}

/**
 * Boots the real process (`src/main.ts`) exactly as production does: configuration
 * from the environment, PostgreSQL persistence, HTTP server. Nothing is injected.
 */
const bootServer=async(url: string): Promise<RunningServer>=>{
  const port=await freePort();
  const child: ChildProcessByStdio<null,Readable,Readable>=spawn(process.execPath,['--experimental-strip-types',ENTRY_POINT],{
    cwd:REPOSITORY_ROOT,
    env:{
      ...process.env,
      NODE_ENV:'test',
      HOST:'127.0.0.1',
      PORT:String(port),
      LOG_LEVEL:'info',
      DATABASE_URL:url,
      DATABASE_SSL:'disable',
      JWT_SECRET:'integration-secret-that-is-long-enough-for-hs256',
      JWT_ISSUER:'rebuplica-27',
      JWT_AUDIENCE:'rebuplica-api',
      ACCESS_TOKEN_TTL_SECONDS:'900',
      CORS_ALLOWED_ORIGINS:'',
    },
    stdio:['ignore','pipe','pipe'],
  });
  const logs: string[]=[];
  const listener=createInterface({input:child.stdout});
  listener.on('line',line=>logs.push(line));
  const errors: string[]=[];
  const errorListener=createInterface({input:child.stderr});
  errorListener.on('line',line=>errors.push(line));

  const listening=await new Promise<boolean>(resolve=>{
    const timer=setTimeout(()=>resolve(false),30_000);
    listener.on('line',line=>{
      if(line.includes('"message":"api listening"')){clearTimeout(timer);resolve(true);}
    });
    child.once('exit',()=>{clearTimeout(timer);resolve(false);});
  });
  if(!listening){
    child.kill('SIGKILL');
    throw new Error(`server did not start.\nstdout:\n${logs.join('\n')}\nstderr:\n${errors.join('\n')}`);
  }
  return {
    port,
    logs,
    stop: async()=>{
      const exited=once(child,'exit');
      child.kill('SIGTERM');
      const [code]=await exited as [number|null];
      listener.close();
      errorListener.close();
      return code;
    },
  };
};

const call=async(server:RunningServer,path:string,options:{method?:string;token?:string;body?:unknown}={}):Promise<{status:number;body:Record<string,unknown>}>=>{
  const headers:Record<string,string>={};
  if(options.token!==undefined)headers['authorization']=`Bearer ${options.token}`;
  if(options.body!==undefined)headers['content-type']='application/json';
  const response=await fetch(`http://127.0.0.1:${server.port}${path}`,{
    method:options.method??(options.body===undefined?'GET':'POST'),
    headers,
    ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
  });
  const text=await response.text();
  return {status:response.status,body:(text===''?{}:JSON.parse(text)) as Record<string,unknown>};
};

describe('persistence across a real process restart',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;

  before(async()=>{
    database=await provisionDatabase('restart');
  },{timeout:120_000});

  after(async()=>{
    await database?.drop();
  });

  it('still has the user, game, events and saves after restarting the process',async()=>{
    assert.ok(database,'database not provisioned');
    const email=`restart-${Date.now().toString(36)}@example.com`;
    const password='a-very-strong-password';

    const first=await bootServer(database.url);
    let gameId='';
    try{
      const health=await call(first,'/health');
      assert.equal(health.status,200);
      const ready=await call(first,'/ready');
      assert.equal(ready.status,200);
      assert.deepEqual(ready.body['checks'],{database:'ok'});

      assert.equal((await call(first,'/auth/register',{body:{email,password}})).status,201);
      const login=await call(first,'/auth/login',{body:{email,password}});
      const token=login.body['accessToken'] as string;
      const created=await call(first,'/games',{token,body:{seed:31337}});
      assert.equal(created.status,201);
      gameId=String((created.body['game'] as Record<string,unknown>)['id']);
      assert.equal((await call(first,`/games/${gameId}/decisions`,{token,body:{type:'SET_ECONOMIC_INDICATOR',payload:{key:'inflation',value:4.2}}})).status,200);
      assert.equal((await call(first,`/games/${gameId}/turn`,{token,body:{days:30}})).status,200);
      assert.equal((await call(first,`/games/${gameId}/saves`,{token,body:{}})).status,201);
    }finally{
      const code=await first.stop();
      assert.equal(code,0,'the server should exit cleanly on SIGTERM');
    }

    // Second process: everything must be rebuilt from PostgreSQL alone.
    const second=await bootServer(database.url);
    try{
      const login=await call(second,'/auth/login',{body:{email,password}});
      assert.equal(login.status,200,'the user must survive a restart');
      const token=login.body['accessToken'] as string;
      const me=await call(second,'/auth/me',{token});
      assert.equal(me.status,200);

      const game=await call(second,`/games/${gameId}`,{token});
      assert.equal(game.status,200,'the game must survive a restart');
      const detail=game.body['game'] as Record<string,unknown>;
      assert.equal(detail['seed'],31337);
      assert.equal(detail['turn'],1);
      assert.equal(detail['currentVersion'],3);
      const state=detail['state'] as Record<string,unknown>;
      assert.deepEqual((state['world'] as Record<string,unknown>)['economy'],{inflation:4.2});

      const events=await call(second,`/games/${gameId}/events`,{token});
      assert.equal((events.body['page'] as Record<string,unknown>)['total'],3);
      const saves=await call(second,`/games/${gameId}/saves`,{token});
      assert.equal((saves.body['page'] as Record<string,unknown>)['total'],1);
      const replay=await call(second,`/games/${gameId}/replay`,{token});
      assert.equal((replay.body['replay'] as Record<string,unknown>)['consistent'],true);

      const other=await call(second,'/auth/register',{body:{email:`other-${email}`,password}});
      assert.equal(other.status,201);
      const otherLogin=await call(second,'/auth/login',{body:{email:`other-${email}`,password}});
      const foreign=await call(second,`/games/${gameId}`,{token:otherLogin.body['accessToken'] as string});
      assert.equal(foreign.status,404);
    }finally{
      await second.stop();
    }
  });

  it('refuses to start when the database is unreachable',async()=>{
    const port=await freePort();
    const child=spawn(process.execPath,['--experimental-strip-types',ENTRY_POINT],{
      cwd:REPOSITORY_ROOT,
      env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:'postgres://127.0.0.1:1/nope',JWT_SECRET:'integration-secret-that-is-long-enough-for-hs256'},
      stdio:['ignore','pipe','pipe'],
    });
    const errors: string[]=[];
    const listener=createInterface({input:child.stderr});
    listener.on('line',line=>errors.push(line));
    const [code]=await once(child,'exit') as [number|null];
    listener.close();
    assert.notEqual(code,0,'startup must fail fast when PostgreSQL is unreachable');
    assert.match(errors.join('\n'),/database is not reachable/u);
  });
});
