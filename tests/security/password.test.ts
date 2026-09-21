import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import {
  DEFAULT_SCRYPT_PARAMETERS,
  WeakPasswordError,
  hashPassword,
  hashPasswordAsync,
  passwordNeedsRehash,
  verifyPassword,
  verifyPasswordAsync,
} from '../../src/security/password.ts';

const PASSWORD='correct horse battery staple';

describe('password hashing',()=>{
  it('hashes and verifies without storing the password',()=>{
    const hash=hashPassword(PASSWORD);
    assert.ok(!hash.includes(PASSWORD));
    assert.equal(verifyPassword(PASSWORD,hash),true);
    assert.equal(verifyPassword('wrong password',hash),false);
  });
  it('stores the scrypt parameters and a random salt per hash',()=>{
    const first=hashPassword(PASSWORD);
    const second=hashPassword(PASSWORD);
    assert.match(first,/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);
    assert.notEqual(first,second);
    assert.equal(verifyPassword(PASSWORD,first),true);
    assert.equal(verifyPassword(PASSWORD,second),true);
  });
  it('uses the documented work factor',()=>{
    assert.equal(DEFAULT_SCRYPT_PARAMETERS.N,32_768);
    assert.equal(DEFAULT_SCRYPT_PARAMETERS.r,8);
    assert.equal(DEFAULT_SCRYPT_PARAMETERS.p,1);
  });
  it('rejects weak and oversized passwords when hashing',()=>{
    assert.throws(()=>hashPassword('short'),WeakPasswordError);
    assert.throws(()=>hashPassword('a'.repeat(201)),WeakPasswordError);
    assert.throws(()=>hashPasswordAsync('short'),WeakPasswordError);
  });
  it('still verifies legacy hashes without the parameter segment',()=>{
    const [algorithm,parameters,salt,derived]=hashPassword(PASSWORD).split('$');
    assert.ok(algorithm&&parameters&&salt&&derived);
    const legacyHash=[algorithm,salt,derived].join('$');
    assert.equal(verifyPassword(PASSWORD,legacyHash),true);
    assert.equal(verifyPassword('wrong password',legacyHash),false);
    assert.equal(passwordNeedsRehash(legacyHash),false);
    assert.equal(verifyPassword(PASSWORD,[algorithm,parameters,salt,derived].join('$')),true);
  });
  it('flags hashes that use different parameters as needing a rehash',()=>{
    const [,parameters,salt,derived]=hashPassword(PASSWORD).split('$');
    assert.ok(parameters&&salt&&derived);
    const cheaper=['scrypt','N=16384,r=8,p=1',salt,derived].join('$');
    assert.equal(passwordNeedsRehash(cheaper),true);
    assert.equal(passwordNeedsRehash(['scrypt',parameters,salt,derived].join('$')),false);
    assert.equal(passwordNeedsRehash('not-a-hash'),true);
  });
  it('never throws on malformed stored hashes',()=>{
    for(const encoded of ['','plaintext','md5$abc','scrypt$','scrypt$$','scrypt$N=1,r=1,p=1$c2FsdA$aGFzaA','$$$','bcrypt$2b$10$abcdefghijklmnopqrstuv']){
      assert.equal(verifyPassword(PASSWORD,encoded),false,`accepted ${JSON.stringify(encoded)}`);
    }
  });
  it('rejects pathological parameters instead of allocating huge memory',()=>{
    const [,parameters,salt,derived]=hashPassword(PASSWORD).split('$');
    assert.ok(parameters&&salt&&derived);
    const hostileParameters=['N=1073741824,r=64,p=32','N=999999999999,r=8,p=1','N=32768,r=99,p=1','N=32768,r=8,p=99','N=abc,r=8,p=1'];
    for(const candidate of hostileParameters){
      assert.equal(verifyPassword(PASSWORD,['scrypt',candidate,salt,derived].join('$')),false,`accepted ${candidate}`);
    }
  });
  it('verifies asynchronously without blocking',async()=>{
    const hash=await hashPasswordAsync(PASSWORD);
    assert.equal(await verifyPasswordAsync(PASSWORD,hash),true);
    assert.equal(await verifyPasswordAsync('wrong password',hash),false);
    assert.equal(await verifyPasswordAsync(PASSWORD,'malformed'),false);
  });
  it('keeps sync and async hashes interchangeable',async()=>{
    const syncHash=hashPassword(PASSWORD);
    const asyncHash=await hashPasswordAsync(PASSWORD);
    assert.equal(await verifyPasswordAsync(PASSWORD,syncHash),true);
    assert.equal(verifyPassword(PASSWORD,asyncHash),true);
  });
});
