import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { SecretBox,SecretBoxError } from '../../src/security/secret-box.ts';

const MASTER = 'a-master-secret-with-at-least-32-characters!!';

describe('SecretBox (AES-256-GCM)',()=>{
  it('round-trips a value and never stores it in clear text',()=>{
    const box = new SecretBox(MASTER);
    const encrypted = box.encrypt('AIzaSyExampleKey1234567890');
    assert.ok(encrypted.startsWith('v1.'));
    assert.ok(!encrypted.includes('AIza'));
    assert.equal(box.decrypt(encrypted),'AIzaSyExampleKey1234567890');
  });

  it('uses a fresh IV so the same plaintext encrypts differently each time',()=>{
    const box = new SecretBox(MASTER);
    assert.notEqual(box.encrypt('same-value-same-value-1'),box.encrypt('same-value-same-value-1'));
  });

  it('rejects a wrong master secret, tampering and malformed payloads',()=>{
    const box = new SecretBox(MASTER);
    const encrypted = box.encrypt('AIzaSyExampleKey1234567890');
    assert.throws(() => new SecretBox('another-master-secret-with-32-chars-min!!').decrypt(encrypted),SecretBoxError);
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered-data').toString('base64url');
    assert.throws(() => box.decrypt(parts.join('.')),SecretBoxError);
    assert.throws(() => box.decrypt('not-a-payload'),SecretBoxError);
    assert.throws(() => box.decrypt('v2.a.b.c'),SecretBoxError);
  });

  it('refuses a short master secret',()=>{
    assert.throws(() => new SecretBox('short'),SecretBoxError);
  });
});
