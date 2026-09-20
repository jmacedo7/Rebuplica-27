import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { Secret } from '../../src/config/index.ts';
const RAW='super-secret-value-123';
describe('Secret',()=>{it('reveals only through reveal()',()=>{assert.equal(new Secret(RAW).reveal(),RAW);});it('does not leak through string conversion',()=>{const secret=new Secret(RAW);assert.equal(String(secret),'[REDACTED]');assert.equal(`${secret}`,'[REDACTED]');});it('does not leak through JSON.stringify',()=>{const json=JSON.stringify({database:{url:new Secret(RAW)}});assert.equal(json,'{"database":{"url":"[REDACTED]"}}');assert.ok(!json.includes(RAW));});it('does not leak through inspect',()=>{const output=inspect({secret:new Secret(RAW)},{depth:5});assert.ok(!output.includes(RAW));assert.ok(output.includes('[REDACTED]'));});});
