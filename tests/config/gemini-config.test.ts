import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe,it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError,loadConfig } from '../../src/config/index.ts';

const VALID_DB = 'postgres://user:password@localhost:5432/rebuplica';
const SCRIPT = fileURLToPath(new URL('../../scripts/check-config.ts',import.meta.url));

const expectConfigError = (env: Record<string,string>): ConfigError => {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError,'expected a ConfigError');
    return error;
  }
  assert.fail('expected loadConfig to throw a ConfigError');
};

describe('loadConfig - Gemini settings',()=>{
  it('leaves the integration pending when GEMINI_API_KEY is absent',()=>{
    const config = loadConfig({DATABASE_URL: VALID_DB});
    assert.equal(config.ai.apiKey,undefined);
    assert.equal(config.ai.model,'gemini-2.5-flash');
    assert.equal(config.ai.timeoutMs,20_000);
  });

  it('accepts a configured key, model and timeout',()=>{
    const config = loadConfig({
      DATABASE_URL: VALID_DB,
      GEMINI_API_KEY: 'AIza-test-key-0123456789abcdef',
      GEMINI_MODEL: 'gemini-2.5-pro',
      GEMINI_TIMEOUT_MS: '5000',
    });
    assert.equal(config.ai.apiKey?.reveal(),'AIza-test-key-0123456789abcdef');
    assert.equal(config.ai.model,'gemini-2.5-pro');
    assert.equal(config.ai.timeoutMs,5_000);
    // The secret must never serialise its value.
    assert.equal(JSON.stringify(config.ai.apiKey),'"[REDACTED]"');
  });

  it('rejects a malformed key, model or timeout without echoing the key',()=>{
    const error = expectConfigError({
      DATABASE_URL: VALID_DB,
      GEMINI_API_KEY: 'short',
      GEMINI_MODEL: 'not a model!',
      GEMINI_TIMEOUT_MS: '10',
    });
    assert.deepEqual(error.issues.map(issue => issue.variable),['GEMINI_API_KEY','GEMINI_MODEL','GEMINI_TIMEOUT_MS']);
    assert.ok(!error.message.includes('short'),'the secret value must stay hidden');
  });
});

describe('scripts/check-config.ts - Gemini secret redaction',()=>{
  it('prints the configuration without ever printing GEMINI_API_KEY',()=>{
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types',SCRIPT],
      {
        env: {
          ...process.env,
          DATABASE_URL: VALID_DB,
          JWT_SECRET: 'ci-secret-that-is-long-enough-for-hs256-signing',
          GEMINI_API_KEY: 'AIza-test-key-0123456789abcdef',
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.includes('AIza-test-key-0123456789abcdef'),'the key must never reach stdout');
    const printed = JSON.parse(result.stdout) as {ai: {apiKey: string}};
    assert.equal(printed.ai.apiKey,'[REDACTED]');
  });
});
