import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import type { GeminiFetcher } from '../../src/ai/gemini.ts';
import { registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';

/**
 * Two ways to use Gemini: the player's own key (stored encrypted, unlimited by the
 * project policy) or the shared project key (limited per player per UTC day).
 */

const PROJECT_KEY = 'project-default-key-1234567890-ABCDEF';
const PERSONAL_KEY = 'AIzaSyPersonalKey-0987654321-ZYXWVU';
const OTHER_KEY = 'AIzaSyAnotherPlayerKey-1111111111-QQ';
const MASTER = 'a-master-secret-with-at-least-32-characters!!';
const PROMPT = 'Escreva uma frase de campanha sobre saúde.';

const rateLimits = {
  auth: {limit: 10_000,windowMs: 60_000},
  write: {limit: 10_000,windowMs: 60_000},
  read: {limit: 10_000,windowMs: 60_000},
  ai: {limit: 10_000,windowMs: 60_000},
};

/** Records which key travelled to the (fake) provider on each call. */
const recordingFetcher = (status = 200): {fetcher: GeminiFetcher; usedKeys: string[]} => {
  const usedKeys: string[] = [];
  return {
    usedKeys,
    fetcher: async request => {
      const headers = (request.init as {headers: Record<string,string>}).headers;
      usedKeys.push(headers['x-goog-api-key'] ?? '');
      if (status !== 200) return new Response('error',{status});
      return new Response(JSON.stringify({candidates: [{content: {parts: [{text: 'Saúde para todos.'}]}}]}),{status: 200});
    },
  };
};

const withServer = async (
  operation: (server: TestServer) => Promise<void>,
  ai: {apiKey?: string | undefined; dailyLimit?: number | undefined; encryptionSecret?: string | undefined; fetcher?: GeminiFetcher | undefined},
): Promise<void> => {
  const server = await startTestServer({ai,rateLimits});
  try { await operation(server); } finally { await server.close(); }
};

const body = (response: {body: Record<string,unknown>}): Record<string,unknown> => response.body['ai'] as Record<string,unknown>;

describe('personal Gemini key',()=>{
  it('requires authentication on every key route',async()=>{
    await withServer(async server => {
      assert.equal((await request(server,'/api/ai/key')).status,401);
      assert.equal((await request(server,'/api/ai/key',{body:{apiKey: PERSONAL_KEY}})).status,401);
      assert.equal((await request(server,'/api/ai/key/remove',{body:{}})).status,401);
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER});
  });

  it('stores the key encrypted and only ever returns a masked hint',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const saved = await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY}});
      assert.equal(saved.status,200);
      const status = body(saved);
      assert.deepEqual(status['personalKey'],{configured: true,hint: 'AIza…WVU'.length > 0 ? `${PERSONAL_KEY.slice(0,4)}…${PERSONAL_KEY.slice(-4)}` : ''});
      assert.ok(!JSON.stringify(saved.body).includes(PERSONAL_KEY),'response must not echo the key');

      const read = await request(server,'/api/ai/key',{token: user.token});
      assert.ok(!JSON.stringify(read.body).includes(PERSONAL_KEY));

      const stored = (server.persistence as unknown as {aiKeys: {records: Map<string,{encryptedKey: string}>}}).aiKeys.records;
      const [record] = [...stored.values()];
      assert.ok(record, 'a record must exist');
      assert.ok(!record.encryptedKey.includes(PERSONAL_KEY),'database value must be ciphertext');
      assert.ok(record.encryptedKey.startsWith('v1.'));
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER});
  });

  it('uses the personal key for generation and skips the project limit',async()=>{
    const {fetcher,usedKeys} = recordingFetcher();
    await withServer(async server => {
      const user = await registerUser(server);
      await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY}});
      for (let index = 0; index < 3; index += 1) {
        const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
        assert.equal(reply.status,200);
        assert.equal(reply.body['source'],'personal');
      }
      assert.deepEqual(usedKeys,[PERSONAL_KEY,PERSONAL_KEY,PERSONAL_KEY]);
      const status = await request(server,'/api/ai/key',{token: user.token});
      assert.equal((body(status)['defaultKey'] as Record<string,unknown>)['usedToday'],0);
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER,dailyLimit: 1,fetcher});
  });

  it('falls back to the project key after the player removes their own',async()=>{
    const {fetcher,usedKeys} = recordingFetcher();
    await withServer(async server => {
      const user = await registerUser(server);
      await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY}});
      const removed = await request(server,'/api/ai/key/remove',{token: user.token,body:{}});
      assert.equal(removed.status,200);
      assert.equal((body(removed)['personalKey'] as Record<string,unknown>)['configured'],false);
      const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(reply.body['source'],'default');
      assert.deepEqual(usedKeys,[PROJECT_KEY]);
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER,fetcher});
  });

  it('never lets one player use or see another player\'s key',async()=>{
    const {fetcher,usedKeys} = recordingFetcher();
    await withServer(async server => {
      const alice = await registerUser(server);
      const bruno = await registerUser(server);
      await request(server,'/api/ai/key',{token: alice.token,body:{apiKey: PERSONAL_KEY}});
      await request(server,'/api/ai/key',{token: bruno.token,body:{apiKey: OTHER_KEY}});
      await request(server,'/api/ai/ping',{token: bruno.token,body:{prompt: PROMPT}});
      assert.deepEqual(usedKeys,[OTHER_KEY]);
      const aliceStatus = await request(server,'/api/ai/key',{token: alice.token});
      assert.ok(!JSON.stringify(aliceStatus.body).includes(OTHER_KEY));
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER,fetcher});
  });

  it('rejects malformed keys and unknown properties',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const tooShort = await request(server,'/api/ai/key',{token: user.token,body:{apiKey: 'short'}});
      assert.equal(tooShort.status,400);
      const withSpaces = await request(server,'/api/ai/key',{token: user.token,body:{apiKey: 'AIza has spaces inside the key 1234'}});
      assert.equal(withSpaces.status,400);
      const extra = await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY,admin: true}});
      assert.equal(extra.status,400);
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER});
  });

  it('refuses to store keys when no encryption secret is configured',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const saved = await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY}});
      assert.equal(saved.status,503);
      assert.equal((saved.body['error'] as Record<string,unknown>)['code'],'AI_NOT_CONFIGURED');
      const status = await request(server,'/api/ai/key',{token: user.token});
      assert.equal(body(status)['personalKeysEnabled'],false);
    },{apiKey: PROJECT_KEY});
  });

  it('reports a rejected personal key without echoing it',async()=>{
    const {fetcher} = recordingFetcher(403);
    await withServer(async server => {
      const user = await registerUser(server);
      await request(server,'/api/ai/key',{token: user.token,body:{apiKey: PERSONAL_KEY}});
      const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(reply.status,503);
      assert.equal((reply.body['error'] as Record<string,unknown>)['code'],'AI_AUTH_FAILED');
      assert.ok(!JSON.stringify(reply.body).includes(PERSONAL_KEY));
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER,fetcher});
  });
});

describe('project key daily limit',()=>{
  it('serves requests with the project key until the daily limit is reached',async()=>{
    const {fetcher,usedKeys} = recordingFetcher();
    await withServer(async server => {
      const user = await registerUser(server);
      for (let index = 0; index < 2; index += 1) {
        const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
        assert.equal(reply.status,200);
        assert.equal(reply.body['source'],'default');
      }
      const blocked = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(blocked.status,429);
      assert.equal((blocked.body['error'] as Record<string,unknown>)['code'],'AI_DAILY_LIMIT_REACHED');
      assert.equal(usedKeys.length,2,'the provider must not be called past the limit');

      const status = await request(server,'/api/ai/key',{token: user.token});
      const defaults = body(status)['defaultKey'] as Record<string,unknown>;
      assert.equal(defaults['usedToday'],2);
      assert.equal(defaults['remainingToday'],0);
    },{apiKey: PROJECT_KEY,encryptionSecret: MASTER,dailyLimit: 2,fetcher});
  });

  it('counts each player separately',async()=>{
    const {fetcher} = recordingFetcher();
    await withServer(async server => {
      const alice = await registerUser(server);
      const bruno = await registerUser(server);
      assert.equal((await request(server,'/api/ai/ping',{token: alice.token,body:{prompt: PROMPT}})).status,200);
      assert.equal((await request(server,'/api/ai/ping',{token: alice.token,body:{prompt: PROMPT}})).status,429);
      assert.equal((await request(server,'/api/ai/ping',{token: bruno.token,body:{prompt: PROMPT}})).status,200);
    },{apiKey: PROJECT_KEY,dailyLimit: 1,fetcher});
  });

  it('does not charge the allowance when the provider fails',async()=>{
    const failing = recordingFetcher(503);
    await withServer(async server => {
      const user = await registerUser(server);
      for (let index = 0; index < 3; index += 1) {
        const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
        assert.equal(reply.status,503);
      }
      const status = await request(server,'/api/ai/key',{token: user.token});
      assert.equal((body(status)['defaultKey'] as Record<string,unknown>)['usedToday'],0);
    },{apiKey: PROJECT_KEY,dailyLimit: 1,fetcher: failing.fetcher});
  });

  it('answers AI_NOT_CONFIGURED when neither a personal nor a project key exists',async()=>{
    await withServer(async server => {
      const user = await registerUser(server);
      const reply = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(reply.status,503);
      assert.equal((reply.body['error'] as Record<string,unknown>)['code'],'AI_NOT_CONFIGURED');
    },{});
  });
});
