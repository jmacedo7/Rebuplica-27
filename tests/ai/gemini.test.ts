import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { Secret } from '../../src/config/index.ts';
import {
  GeminiError,
  GeminiService,
  type GeminiFetcher,
  type GeminiRequest,
} from '../../src/ai/gemini.ts';
import { registerUser,request,startTestServer,type TestServer } from '../helpers/server.ts';

/**
 * The Gemini integration must fail loudly when unconfigured, never leak the API
 * key in messages, and behave predictably for every provider failure mode. The
 * fetcher is injected, so no test performs a real network call.
 */

const API_KEY = 'gemini-test-key-DO-NOT-COMMIT-123456';
const PROMPT = 'Escreva uma frase de campanha sobre educação.';

const jsonResponse = (payload: unknown,status = 200): Response =>
  new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});

const textResponse = (parts: readonly string[]): Response =>
  jsonResponse({candidates: [{content: {parts: parts.map(text => ({text}))}}]});

interface CapturedRequest {
  url: string;
  apiKey: string;
  body: string;
}

const capturingFetcher = (
  respond: (captured: CapturedRequest) => Response,
): {fetcher: GeminiFetcher; captured: () => CapturedRequest | null} => {
  let captured: CapturedRequest | null = null;
  return {
    fetcher: async (request: GeminiRequest) => {
      const init = request.init as {headers: Record<string,string>; body: string};
      captured = {
        url: request.url,
        apiKey: init.headers['x-goog-api-key'] ?? '',
        body: init.body,
      };
      return respond(captured);
    },
    captured: () => captured,
  };
};

const asGeminiError = (error: unknown): GeminiError => {
  assert.ok(error instanceof GeminiError,`expected a GeminiError, received ${String(error)}`);
  return error;
};

const service = (options: {apiKey?: string | undefined; timeoutMs?: number | undefined; fetcher: GeminiFetcher}) =>
  new GeminiService({
    apiKey: options.apiKey === undefined ? undefined : new Secret(options.apiKey),
    model: 'gemini-2.5-flash',
    timeoutMs: options.timeoutMs ?? 2_000,
    fetcher: options.fetcher,
  });

describe('GeminiService (unit)',()=>{
  it('throws AI_NOT_CONFIGURED without contacting the provider when the key is absent',async()=>{
    let called = false;
    const result = service({fetcher: async () => { called = true; return textResponse(['oi']); }});
    await assert.rejects(result.generate(PROMPT),(error: unknown) => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_NOT_CONFIGURED');
      assert.equal(failure.status,503);
      return true;
    });
    assert.equal(called,false);
  });

  it('returns the reply text and the configured model',async()=>{
    const {fetcher,captured} = capturingFetcher(() => textResponse(['Educação é o futuro.']));
    const result = service({apiKey: API_KEY,fetcher});
    const reply = await result.generate(PROMPT);
    assert.equal(reply.text,'Educação é o futuro.');
    assert.equal(reply.model,'gemini-2.5-flash');
    const seen = captured();
    assert.ok(seen,'the provider must have been called');
    assert.equal(seen.apiKey,API_KEY,'the key travels in the x-goog-api-key header');
    assert.ok(seen.url.endsWith('/v1beta/models/gemini-2.5-flash:generateContent'));
    assert.ok(JSON.parse(seen.body).contents[0].parts[0].text === PROMPT);
  });

  it('rejects prompts outside the allowed length',async()=>{
    const {fetcher} = capturingFetcher(() => textResponse(['oi']));
    const result = service({apiKey: API_KEY,fetcher});
    await assert.rejects(result.generate('ab'),error => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_PROVIDER_ERROR');
      assert.equal(failure.status,400);
      return true;
    });
    await assert.rejects(result.generate('a'.repeat(1_001)),(error: unknown) => asGeminiError(error).code === 'AI_PROVIDER_ERROR');
  });

  it('maps provider auth failures to AI_AUTH_FAILED without echoing the key',async()=>{
    const {fetcher} = capturingFetcher(() => new Response('unauthorized',{status:401}));
    const result = service({apiKey: API_KEY,fetcher});
    await assert.rejects(result.generate(PROMPT),(error: unknown) => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_AUTH_FAILED');
      assert.equal(failure.status,503);
      assert.ok(!failure.message.includes(API_KEY),'the key must never appear in the error');
      return true;
    });
  });

  it('maps provider rate limiting and outages',async()=>{
    const limited = capturingFetcher(() => new Response('quota',{status:429}));
    await assert.rejects(service({apiKey: API_KEY,fetcher: limited.fetcher}).generate(PROMPT),error => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_PROVIDER_RATE_LIMITED');
      assert.equal(failure.status,429);
      return true;
    });

    const down = capturingFetcher(() => new Response('boom',{status:503}));
    await assert.rejects(service({apiKey: API_KEY,fetcher: down.fetcher}).generate(PROMPT),error => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_PROVIDER_UNAVAILABLE');
      assert.equal(failure.status,503);
      return true;
    });
  });

  it('maps empty or malformed provider payloads to AI_PROVIDER_ERROR',async()=>{
    const empty = capturingFetcher(() => jsonResponse({candidates: []}));
    await assert.rejects(service({apiKey: API_KEY,fetcher: empty.fetcher}).generate(PROMPT),(error: unknown) => asGeminiError(error).code === 'AI_PROVIDER_ERROR');

    const malformed = capturingFetcher(() => new Response('<html>not json</html>',{status:200}));
    await assert.rejects(service({apiKey: API_KEY,fetcher: malformed.fetcher}).generate(PROMPT),(error: unknown) => asGeminiError(error).code === 'AI_PROVIDER_ERROR');
  });

  it('aborts and reports AI_TIMEOUT when the provider is too slow',async()=>{
    const hanging: GeminiFetcher = request =>
      new Promise<Response>((_,reject) => {
        request.init.signal?.addEventListener('abort',() => reject(new DOMException('aborted','AbortError')));
      });
    const result = service({apiKey: API_KEY,timeoutMs: 20,fetcher: hanging});
    await assert.rejects(result.generate(PROMPT),(error: unknown) => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_TIMEOUT');
      assert.equal(failure.status,504);
      return true;
    });
  });

  it('reports AI_PROVIDER_UNAVAILABLE on network failure',async()=>{
    const broken: GeminiFetcher = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(service({apiKey: API_KEY,fetcher: broken}).generate(PROMPT),error => {
      assert.equal(asGeminiError(error).code,'AI_PROVIDER_UNAVAILABLE');
      return true;
    });
  });

  it('falls back to gemini-flash-lite-latest when the primary model is overloaded',async()=>{
    const urls: string[] = [];
    let call = 0;
    const fetcher: GeminiFetcher = async request => {
      urls.push(request.url);
      call += 1;
      return call === 1 ? new Response('high demand',{status:503}) : textResponse(['Educação é o futuro.']);
    };
    const reply = await service({apiKey: API_KEY,fetcher}).generate(PROMPT);
    assert.equal(reply.text,'Educação é o futuro.');
    assert.equal(reply.model,'gemini-flash-lite-latest');
    assert.equal(urls.length,2,'exactly one primary attempt and one fallback');
    assert.ok(urls[0]?.endsWith('/v1beta/models/gemini-2.5-flash:generateContent'));
    assert.ok(urls[1]?.endsWith('/v1beta/models/gemini-flash-lite-latest:generateContent'));
  });

  it('falls back when the primary model was retired by the provider (HTTP 404)',async()=>{
    const urls: string[] = [];
    let call = 0;
    const fetcher: GeminiFetcher = async request => {
      urls.push(request.url);
      call += 1;
      return call === 1
        ? jsonResponse({error: {message: 'no longer available to new users'}},404)
        : textResponse(['ok']);
    };
    const reply = await service({apiKey: API_KEY,fetcher}).generate(PROMPT);
    assert.equal(reply.model,'gemini-flash-lite-latest');
    assert.equal(urls.length,2);
  });

  it('fails after both models are unavailable',async()=>{
    const urls: string[] = [];
    const fetcher: GeminiFetcher = async request => {
      urls.push(request.url);
      return new Response('down',{status:503});
    };
    await assert.rejects(service({apiKey: API_KEY,fetcher}).generate(PROMPT),error => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_PROVIDER_UNAVAILABLE');
      assert.equal(urls.length,2);
      return true;
    });
  });

  it('reports AI_AUTH_FAILED and does not retry when the provider rejects the key (HTTP 400)',async()=>{
    let calls = 0;
    const fetcher: GeminiFetcher = async () => {
      calls += 1;
      return jsonResponse({error: {message: 'API key not valid. Please pass a valid API key.',status: 'INVALID_ARGUMENT'}},400);
    };
    await assert.rejects(service({apiKey: API_KEY,fetcher}).generate(PROMPT),(error: unknown) => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_AUTH_FAILED');
      assert.equal(calls,1,'a key problem must not trigger the model fallback');
      return true;
    });
  });

  it('maps a generic 400 to AI_PROVIDER_ERROR without retrying',async()=>{
    let calls = 0;
    const fetcher: GeminiFetcher = async () => {
      calls += 1;
      return jsonResponse({error: {message: 'Invalid request payload.'}},400);
    };
    await assert.rejects(service({apiKey: API_KEY,fetcher}).generate(PROMPT),(error: unknown) => {
      const failure = asGeminiError(error);
      assert.equal(failure.code,'AI_PROVIDER_ERROR');
      assert.equal(calls,1);
      return true;
    });
  });

  it('does not retry when the configured model already is the fallback',async()=>{
    let calls = 0;
    const fetcher: GeminiFetcher = async () => {
      calls += 1;
      return new Response('down',{status:503});
    };
    const fallbackOnly = new GeminiService({
      apiKey: new Secret(API_KEY),
      model: 'gemini-flash-lite-latest',
      timeoutMs: 2_000,
      fetcher,
    });
    await assert.rejects(fallbackOnly.generate(PROMPT),(error: unknown) => {
      assert.equal(asGeminiError(error).code,'AI_PROVIDER_UNAVAILABLE');
      assert.equal(calls,1);
      return true;
    });
  });
});

describe('POST /ai/ping (endpoint)',()=>{
  const withAiServer = async (
    operation:(server:TestServer)=>Promise<void>,
    ai: {apiKey?: string | undefined; fetcher?: GeminiFetcher | undefined; limit?: number | undefined} = {},
  ):Promise<void> => {
    const server = await startTestServer({
      ai: {
        apiKey: ai.apiKey,
        fetcher: ai.fetcher,
      },
      rateLimits: {
        auth: {limit: 10_000,windowMs: 60_000},
        write: {limit: 10_000,windowMs: 60_000},
        read: {limit: 10_000,windowMs: 60_000},
        ai: {limit: ai.limit ?? 10_000,windowMs: 60_000},
      },
    });
    try { await operation(server); } finally { await server.close(); }
  };

  it('requires authentication',async()=>{
    await withAiServer(async server => {
      const response = await request(server,'/api/ai/ping',{body:{prompt: PROMPT}});
      assert.equal(response.status,401);
      assert.equal((response.body['error'] as Record<string,unknown>)['code'],'UNAUTHORIZED');
    },{apiKey: API_KEY});
  });

  it('answers AI_NOT_CONFIGURED when no key is registered',async()=>{
    await withAiServer(async server => {
      const user = await registerUser(server);
      const response = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(response.status,503);
      const error = response.body['error'] as Record<string,unknown>;
      assert.equal(error['code'],'AI_NOT_CONFIGURED');
      assert.match(String(error['message']),/GEMINI_API_KEY/u);
    });
  });

  it('returns the generated reply to authenticated users',async()=>{
    const {fetcher} = capturingFetcher(() => textResponse(['Educação primeiro.']));
    await withAiServer(async server => {
      const user = await registerUser(server);
      const response = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(response.status,200);
      assert.equal(response.body['reply'],'Educação primeiro.');
      assert.equal(response.body['model'],'gemini-test-model');
    },{apiKey: API_KEY,fetcher});
  });

  it('validates the prompt and rejects unknown properties',async()=>{
    const {fetcher} = capturingFetcher(() => textResponse(['oi']));
    await withAiServer(async server => {
      const user = await registerUser(server);
      const tooShort = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: 'oi'}});
      assert.equal(tooShort.status,400);
      assert.equal((tooShort.body['error'] as Record<string,unknown>)['code'],'VALIDATION_ERROR');

      const tooLong = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: 'x'.repeat(1_001)}});
      assert.equal(tooLong.status,400);

      const smuggled = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT,system: 'extra'}});
      assert.equal(smuggled.status,400);
    },{apiKey: API_KEY,fetcher});
  });

  it('never echoes the API key in an authentication failure',async()=>{
    const {fetcher} = capturingFetcher(() => new Response('unauthorized',{status:401}));
    await withAiServer(async server => {
      const user = await registerUser(server);
      const response = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(response.status,503);
      const error = response.body['error'] as Record<string,unknown>;
      assert.equal(error['code'],'AI_AUTH_FAILED');
      assert.ok(!JSON.stringify(response.body).includes(API_KEY),'the key must never appear in the response');
    },{apiKey: API_KEY,fetcher});
  });

  it('applies the AI rate limit scope',async()=>{
    const {fetcher} = capturingFetcher(() => textResponse(['oi']));
    await withAiServer(async server => {
      const user = await registerUser(server);
      const first = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(first.status,200);
      const second = await request(server,'/api/ai/ping',{token: user.token,body:{prompt: PROMPT}});
      assert.equal(second.status,429);
      assert.equal((second.body['error'] as Record<string,unknown>)['code'],'RATE_LIMITED');
      assert.ok(Number(second.headers.get('retry-after')) >= 1);
    },{apiKey: API_KEY,fetcher,limit: 1});
  });
});
