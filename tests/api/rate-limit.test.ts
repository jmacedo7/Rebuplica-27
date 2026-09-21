import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { DEFAULT_RATE_LIMITS,RateLimiter,createRateLimiterSet } from '../../src/api/rate-limit.ts';

describe('RateLimiter',()=>{
  it('allows up to the limit and rejects the next request in the same window',()=>{
    const limiter=new RateLimiter({limit:2,windowMs:1000});
    assert.equal(limiter.check('a',0).allowed,true);
    assert.equal(limiter.check('a',1).allowed,true);
    const denied=limiter.check('a',2);
    assert.equal(denied.allowed,false);
    assert.equal(denied.remaining,0);
    assert.ok(denied.retryAfterSeconds>=1);
  });
  it('starts a fresh window after it expires',()=>{
    const limiter=new RateLimiter({limit:1,windowMs:1000});
    assert.equal(limiter.check('a',0).allowed,true);
    assert.equal(limiter.check('a',999).allowed,false);
    assert.equal(limiter.check('a',1000).allowed,true);
  });
  it('tracks keys independently and reports the remaining budget',()=>{
    const limiter=new RateLimiter({limit:3,windowMs:1000});
    limiter.check('a',0);
    assert.equal(limiter.check('a',0).remaining,1);
    assert.equal(limiter.check('b',0).remaining,2);
  });
  it('drops expired entries when swept',()=>{
    const limiter=new RateLimiter({limit:5,windowMs:1000});
    for(let index=0;index<50;index+=1)limiter.check(`key-${index}`,0);
    assert.equal(limiter.size,50);
    assert.equal(limiter.sweep(500),0);
    assert.equal(limiter.sweep(1001),50);
    assert.equal(limiter.size,0);
  });
  it('never grows past maxEntries',()=>{
    const limiter=new RateLimiter({limit:10,windowMs:60_000},{maxEntries:25});
    for(let index=0;index<500;index+=1)limiter.check(`key-${index}`,0);
    assert.ok(limiter.size<=25,`expected at most 25 tracked keys, found ${limiter.size}`);
  });
  it('evicts the entries closest to expiry first when over capacity',()=>{
    const limiter=new RateLimiter({limit:5,windowMs:60_000},{maxEntries:2});
    limiter.check('expires-first',0); // resetAt 60000
    limiter.check('expires-later',10_000); // resetAt 70000
    limiter.check('newest',20_000); // removed oldest -> size stays at 2
    assert.equal(limiter.size,2);
    assert.equal(limiter.check('expires-first',20_000).remaining,4);
  });
  it('sweeps expired windows during normal traffic',()=>{
    const limiter=new RateLimiter({limit:1000,windowMs:10});
    for(let index=0;index<20;index+=1)limiter.check(`phase-1-${index}`,0);
    for(let index=0;index<513;index+=1)limiter.check(`phase-2-${index}`,1000);
    assert.ok(limiter.size<=513,`expired keys were retained: ${limiter.size}`);
  });
  it('resets everything on demand',()=>{
    const limiter=new RateLimiter({limit:1,windowMs:1000});
    limiter.check('a',0);
    limiter.reset();
    assert.equal(limiter.size,0);
    assert.equal(limiter.check('a',0).allowed,true);
  });
  it('rejects invalid rules',()=>{
    assert.throws(()=>new RateLimiter({limit:0,windowMs:1000}));
    assert.throws(()=>new RateLimiter({limit:1,windowMs:0}));
    assert.throws(()=>new RateLimiter({limit:1,windowMs:1000},{maxEntries:0}));
  });
});

describe('createRateLimiterSet',()=>{
  it('keeps auth, write and read budgets independent',()=>{
    const limiters=createRateLimiterSet(DEFAULT_RATE_LIMITS);
    for(let index=0;index<DEFAULT_RATE_LIMITS.auth.limit;index+=1)limiters.check('auth','1.2.3.4',0);
    assert.equal(limiters.check('auth','1.2.3.4',0).allowed,false);
    assert.equal(limiters.check('read','1.2.3.4',0).allowed,true);
    assert.equal(limiters.check('write','1.2.3.4',0).allowed,true);
  });
  it('isolates clients from each other',()=>{
    const limiters=createRateLimiterSet({auth:{limit:1,windowMs:1000},write:{limit:1,windowMs:1000},read:{limit:1,windowMs:1000}});
    assert.equal(limiters.check('auth','10.0.0.1',0).allowed,true);
    assert.equal(limiters.check('auth','10.0.0.1',0).allowed,false);
    assert.equal(limiters.check('auth','10.0.0.2',0).allowed,true);
  });
});
