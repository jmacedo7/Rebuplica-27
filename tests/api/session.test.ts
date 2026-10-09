import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { request,startTestServer,type TestServer } from '../helpers/server.ts';

/**
 * Password authentication now also issues an opaque browser session (HttpOnly
 * cookie). These tests prove the full lifecycle: login sets the cookie, the
 * cookie authenticates /auth/me, the session token doubles as a bearer, logout
 * revokes the session and clears the cookie, and the legacy access token keeps
 * working for non-browser API clients.
 */

const cookieValue = (header:string|null):string => {
  assert.ok(header,'expected a Set-Cookie header');
  const value = header.split(';')[0]?.split('=')[1];
  assert.ok(value,'expected a cookie value');
  return decodeURIComponent(value);
};

const withServer = async (operation:(server:TestServer)=>Promise<void>):Promise<void> => {
  const server = await startTestServer();
  try { await operation(server); } finally { await server.close(); }
};

const EMAIL = 'presidente@example.com';
const PASSWORD = 'a-very-strong-password';

const login = (server:TestServer,email = EMAIL,password = PASSWORD) =>
  request(server,'/api/auth/login',{body:{email,password}});

describe('POST /auth/login (browser session cookie)',()=>{
  it('issues an httpOnly, Secure, SameSite=None session cookie',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const response = await login(server);
      assert.equal(response.status,200);
      assert.equal(typeof response.body['accessToken'],'string');
      assert.equal(typeof response.body['expiresAt'],'string');

      const setCookie = response.headers.get('set-cookie');
      assert.ok(setCookie?.startsWith('session_token='),'cookie must be the session cookie');
      assert.ok(setCookie?.includes('HttpOnly'),'cookie must be httpOnly');
      assert.ok(setCookie?.includes('Secure'),'cookie must be Secure');
      assert.ok(setCookie?.includes('SameSite=None'),'cookie must work cross-origin with credentials');
    });
  });

  it('authenticates /auth/me from the cookie alone',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const response = await login(server);
      const token = cookieValue(response.headers.get('set-cookie'));
      const me = await request(server,'/api/auth/me',{headers:{cookie:`session_token=${token}`}});
      assert.equal(me.status,200);
      assert.equal((me.body['user'] as Record<string,unknown>)['email'],EMAIL);
    });
  });

  it('accepts the session token as a bearer for API clients',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const response = await login(server);
      const token = cookieValue(response.headers.get('set-cookie'));
      const games = await request(server,'/api/games',{token});
      assert.equal(games.status,200);
      assert.ok(Array.isArray(games.body['games']));
    });
  });

  it('keeps the short lived access token working for non-browser clients',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const response = await login(server);
      const me = await request(server,'/api/auth/me',{token:String(response.body['accessToken'])});
      assert.equal(me.status,200);
    });
  });

  it('rejects an unknown session cookie with 401',async()=>{
    await withServer(async server => {
      const me = await request(server,'/api/auth/me',{headers:{cookie:'session_token=forged-session-token'}});
      assert.equal(me.status,401);
      assert.equal((me.body['error'] as Record<string,unknown>)['code'],'UNAUTHORIZED');
    });
  });

  it('logout revokes the session and clears the cookie',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const response = await login(server);
      const token = cookieValue(response.headers.get('set-cookie'));
      const cookie = `session_token=${token}`;

      const loggedOut = await request(server,'/api/auth/logout',{headers:{cookie},body:{}});
      assert.equal(loggedOut.status,200);
      assert.ok(loggedOut.headers.get('set-cookie')?.includes('Max-Age=0'),'logout must clear the cookie');

      const after = await request(server,'/api/auth/me',{headers:{cookie}});
      assert.equal(after.status,401);
    });
  });
});

describe('POST /auth/register (display name)',()=>{
  it('stores an optional displayName',async()=>{
    await withServer(async server => {
      const response = await request(server,'/api/auth/register',{
        body:{email:'candidata@example.com',password:PASSWORD,displayName:'Candidata Teste'},
      });
      assert.equal(response.status,201);
      assert.equal((response.body['user'] as Record<string,unknown>)['displayName'],'Candidata Teste');
    });
  });

  it('accepts registration without a displayName',async()=>{
    await withServer(async server => {
      const response = await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      assert.equal(response.status,201);
      assert.equal((response.body['user'] as Record<string,unknown>)['displayName'],null);
    });
  });

  it('rejects an oversized displayName',async()=>{
    await withServer(async server => {
      const response = await request(server,'/api/auth/register',{
        body:{email:EMAIL,password:PASSWORD,displayName:'x'.repeat(81)},
      });
      assert.equal(response.status,400);
      assert.equal((response.body['error'] as Record<string,unknown>)['code'],'VALIDATION_ERROR');
    });
  });

  it('rejects a duplicated email with 409',async()=>{
    await withServer(async server => {
      await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      const second = await request(server,'/api/auth/register',{body:{email:EMAIL,password:PASSWORD}});
      assert.equal(second.status,409);
      assert.equal((second.body['error'] as Record<string,unknown>)['code'],'EMAIL_ALREADY_EXISTS');
    });
  });
});
