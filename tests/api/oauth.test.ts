import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { request,startTestServer,type TestServer } from '../helpers/server.ts';
import type { OAuthProfile } from '../../src/api/oauth.ts';

/**
 * Emergent-managed Google login. The call to the Emergent auth service is injected,
 * so these tests exercise our own contract: one-shot session_id exchange, httpOnly
 * cookie, cookie-based authentication, profile refresh on re-login and logout.
 */

const profileFor = (sessionId: string): OAuthProfile => ({
  id:`google-${sessionId}`,
  email:'deputada@example.com',
  name:'Deputada Teste',
  picture:'https://example.com/avatar.png',
  sessionToken:`session-token-${sessionId}`,
});

const withServer = async (
  operation:(server:TestServer)=>Promise<void>,
  fetcher:(sessionId:string)=>Promise<OAuthProfile> = async sessionId => profileFor(sessionId),
):Promise<void> => {
  const server = await startTestServer({oauthProfileFetcher:fetcher});
  try { await operation(server); } finally { await server.close(); }
};

const cookieValue = (header:string|null):string => {
  assert.ok(header,'expected a Set-Cookie header');
  const value = header.split(';')[0]?.split('=')[1];
  assert.ok(value,'expected a cookie value');
  return decodeURIComponent(value);
};

describe('POST /auth/session (Emergent Google login)',()=>{
  it('exchanges a session_id for an httpOnly cookie and a user',async()=>{
    await withServer(async server => {
      const exchanged = await request(server,'/api/auth/session',{headers:{'x-session-id':'abc123'},body:{}});
      assert.equal(exchanged.status,200);
      const user = exchanged.body['user'] as Record<string,unknown>;
      assert.equal(user['email'],'deputada@example.com');
      assert.equal(user['displayName'],'Deputada Teste');
      assert.equal(user['pictureUrl'],'https://example.com/avatar.png');
      assert.equal(typeof exchanged.body['expiresAt'],'string');

      const setCookie = exchanged.headers.get('set-cookie');
      assert.ok(setCookie?.includes('HttpOnly'),'cookie must be httpOnly');
      assert.ok(setCookie?.includes('Secure'),'cookie must be Secure');
      assert.ok(setCookie?.includes('SameSite=Lax'));
      assert.ok(!setCookie?.includes('session-token-abc123') === false,'cookie carries the session token');

      const token = cookieValue(setCookie);
      const me = await request(server,'/api/auth/me',{headers:{cookie:`session_token=${token}`}});
      assert.equal(me.status,200);
      assert.equal((me.body['user'] as Record<string,unknown>)['email'],'deputada@example.com');
    });
  });

  it('accepts the session token as a bearer as well',async()=>{
    await withServer(async server => {
      const exchanged = await request(server,'/api/auth/session',{body:{session_id:'bearer-flow'}});
      const token = cookieValue(exchanged.headers.get('set-cookie'));
      const games = await request(server,'/api/games',{token});
      assert.equal(games.status,200);
      assert.ok(Array.isArray(games.body['games']));
    });
  });

  it('reuses the account and refreshes the profile on the next login',async()=>{
    let round = 0;
    await withServer(
      async server => {
        const first = await request(server,'/api/auth/session',{body:{session_id:'one'}});
        const second = await request(server,'/api/auth/session',{body:{session_id:'two'}});
        assert.equal(second.status,200);
        const firstUser = first.body['user'] as Record<string,unknown>;
        const secondUser = second.body['user'] as Record<string,unknown>;
        assert.equal(firstUser['id'],secondUser['id'],'the same email must map to one account');
        assert.equal(secondUser['displayName'],'Nome Atualizado');

        // The first cookie stays valid: sessions are independent.
        const stillValid = await request(server,'/api/auth/me',{
          headers:{cookie:`session_token=${cookieValue(first.headers.get('set-cookie'))}`},
        });
        assert.equal(stillValid.status,200);
      },
      async sessionId => {
        round += 1;
        return {...profileFor(sessionId),name:round === 1 ? 'Deputada Teste' : 'Nome Atualizado'};
      },
    );
  });

  it('rejects a missing session_id',async()=>{
    await withServer(async server => {
      const response = await request(server,'/api/auth/session',{body:{}});
      assert.equal(response.status,400);
      assert.equal((response.body['error'] as Record<string,unknown>)['code'],'VALIDATION_ERROR');
    });
  });

  it('rejects an unusable cookie',async()=>{
    await withServer(async server => {
      const response = await request(server,'/api/auth/me',{headers:{cookie:'session_token=not-a-real-session'}});
      assert.equal(response.status,401);
    });
  });

  it('logs out: the cookie is cleared and the session stops working',async()=>{
    await withServer(async server => {
      const exchanged = await request(server,'/api/auth/session',{body:{session_id:'logout-flow'}});
      const token = cookieValue(exchanged.headers.get('set-cookie'));
      const cookie = `session_token=${token}`;

      const loggedOut = await request(server,'/api/auth/logout',{headers:{cookie},body:{}});
      assert.equal(loggedOut.status,200);
      assert.ok(loggedOut.headers.get('set-cookie')?.includes('Max-Age=0'),'logout must clear the cookie');

      const after = await request(server,'/api/auth/me',{headers:{cookie}});
      assert.equal(after.status,401);
    });
  });

  it('keeps password accounts untouched by the OAuth flow',async()=>{
    await withServer(async server => {
      const email = 'senha@example.com';
      const registered = await request(server,'/api/auth/register',{body:{email,password:'a-very-strong-password'}});
      assert.equal(registered.status,201);
      const login = await request(server,'/api/auth/login',{body:{email,password:'a-very-strong-password'}});
      assert.equal(login.status,200);
      const me = await request(server,'/api/auth/me',{token:String(login.body['accessToken'])});
      assert.equal(me.status,200);
      assert.equal((me.body['user'] as Record<string,unknown>)['displayName'],null);
    });
  });
});
