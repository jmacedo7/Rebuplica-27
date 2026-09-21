import assert from 'node:assert/strict';
import { createHmac,randomBytes } from 'node:crypto';
import { describe,it } from 'node:test';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  InvalidTokenError,
  issueAccessToken,
  verifyAccessToken,
  verifyAccessTokenWithOptions,
} from '../../src/security/jwt.ts';

const SECRET='test-secret-that-is-long-enough';
const ISSUER='rebuplica';
const AUDIENCE='api';
const NOW=1_700_000_000;

const issue=(overrides:{ttl?:number;now?:number;secret?:string}={}):string =>
  issueAccessToken('user-1',overrides.secret ?? SECRET,ISSUER,AUDIENCE,overrides.ttl ?? 60,overrides.now ?? NOW);

const tamper=(token:string,mutate:(parts:string[])=>string[]):string=>mutate(token.split('.')).join('.');

const forge=(header:Record<string,unknown>,payload:Record<string,unknown>,secret:string|null):string=>{
  const encode=(value:unknown):string=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const head=encode(header);
  const body=encode(payload);
  if(secret===null)return `${head}.${body}.`;
  return `${head}.${body}.${createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')}`;
};

describe('access tokens',()=>{
  it('enforces signature issuer audience and expiration',()=>{
    const token=issue();
    assert.equal(verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW+1).sub,'user-1');
    assert.throws(()=>verifyAccessToken(token,'wrong',ISSUER,AUDIENCE,NOW+1),/Invalid access token/);
    assert.throws(()=>verifyAccessToken(token,SECRET,'other',AUDIENCE,NOW+1),/Invalid access token/);
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,'other',NOW+1),/Invalid access token/);
    // Expiration is enforced with the clock skew allowance (30 s by default) and strictly with skew 0.
    assert.equal(verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW+29).sub,'user-1');
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW+90),/Invalid access token/);
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW+61,0),/Invalid access token/);
  });
  it('includes iat, exp and a unique jti',()=>{
    const first=issue();
    const second=issue();
    const claims=verifyAccessToken(first,SECRET,ISSUER,AUDIENCE,NOW);
    assert.equal(claims.iat,NOW);
    assert.equal(claims.exp,NOW+60);
    assert.match(claims.jti,/^[0-9a-f]{32}$/u);
    assert.notEqual(claims.jti,verifyAccessToken(second,SECRET,ISSUER,AUDIENCE,NOW).jti);
  });
  it('rejects the alg:none downgrade',()=>{
    const token=forge({alg:'none',typ:'JWT'},{sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'},null);
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
  });
  it('rejects a substituted algorithm even when the signature is well formed',()=>{
    const token=forge({alg:'RS256',typ:'JWT'},{sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'},SECRET);
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
    const wrongType=forge({alg:'HS256',typ:'JWE'},{sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'},SECRET);
    assert.throws(()=>verifyAccessToken(wrongType,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
  });
  it('rejects tampered payloads and signatures',()=>{
    const token=issue();
    const elevated=tamper(token,parts=>[parts[0] ?? '',Buffer.from(JSON.stringify({sub:'admin',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'})).toString('base64url'),parts[2] ?? '']);
    assert.throws(()=>verifyAccessToken(elevated,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
    assert.throws(()=>verifyAccessToken(tamper(token,parts=>[parts[0] ?? '',parts[1] ?? '',Buffer.from(randomBytes(32)).toString('base64url')]),SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
    assert.throws(()=>verifyAccessToken(tamper(token,parts=>[parts[0] ?? '',parts[1] ?? '',Buffer.from('short').toString('base64url')]),SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
  });
  it('rejects structurally invalid tokens without throwing unexpected errors',()=>{
    for(const token of ['','x','a.b','a.b.c.d','....','eyJhbGciOiJIUzI1NiJ9.e30.%%%',' not-a-token ']){
      assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError,`accepted ${JSON.stringify(token)}`);
    }
  });
  it('rejects tokens whose claims have the wrong types',()=>{
    const wrongSubject=forge({alg:'HS256',typ:'JWT'},{sub:42,iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'},SECRET);
    assert.throws(()=>verifyAccessToken(wrongSubject,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
    for(const claims of [
      {sub:'','iss':ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:'x'},
      {sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:'now',exp:NOW+60,jti:'x'},
      {sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60,jti:''},
      {sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+60},
      {sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW+61,exp:NOW+60,jti:'x'},
      {sub:'user-1',iss:ISSUER,aud:[AUDIENCE],iat:NOW,exp:NOW+60,jti:'x'},
    ]){
      assert.throws(()=>verifyAccessToken(forge({alg:'HS256',typ:'JWT'},claims,SECRET),SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError,JSON.stringify(claims));
    }
  });
  it('tolerates a small clock skew and refuses a token that is not valid yet',()=>{
    const future=issue({now:NOW+5});
    assert.throws(()=>verifyAccessToken(future,SECRET,ISSUER,AUDIENCE,NOW,0),InvalidTokenError);
    assert.equal(verifyAccessToken(future,SECRET,ISSUER,AUDIENCE,NOW,DEFAULT_CLOCK_SKEW_SECONDS).sub,'user-1');
    const notBefore=forge({alg:'HS256',typ:'JWT'},{sub:'user-1',iss:ISSUER,aud:AUDIENCE,iat:NOW,exp:NOW+600,nbf:NOW+600,jti:'x'},SECRET);
    assert.throws(()=>verifyAccessToken(notBefore,SECRET,ISSUER,AUDIENCE,NOW,0),InvalidTokenError);
  });
  it('refuses absurd lifetimes and empty subjects when issuing',()=>{
    assert.throws(()=>issueAccessToken('','secret',ISSUER,AUDIENCE,60,NOW));
    assert.throws(()=>issueAccessToken('user-1',SECRET,ISSUER,AUDIENCE,0,NOW));
    assert.throws(()=>issueAccessToken('user-1',SECRET,ISSUER,AUDIENCE,86_401,NOW));
  });
  it('refuses oversized tokens before doing cryptographic work',()=>{
    const token=`${'a'.repeat(5000)}.b.c`;
    assert.throws(()=>verifyAccessToken(token,SECRET,ISSUER,AUDIENCE,NOW),InvalidTokenError);
  });
  it('accepts the options object form used by the API',()=>{
    const token=issue();
    const claims=verifyAccessTokenWithOptions(token,{secret:SECRET,issuer:ISSUER,audience:AUDIENCE,nowSeconds:NOW});
    assert.equal(claims.sub,'user-1');
    assert.throws(()=>verifyAccessTokenWithOptions(token,{secret:'other',issuer:ISSUER,audience:AUDIENCE,nowSeconds:NOW}),InvalidTokenError);
  });
});
