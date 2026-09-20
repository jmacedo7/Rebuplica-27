import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { ENV_VAR_NAMES, loadConfig } from '../../src/config/index.ts';
const example=parseEnv(readFileSync(new URL('../../.env.example',import.meta.url),'utf8'));
describe('.env.example',()=>{it('documents exactly the variables read by loadConfig',()=>{assert.deepEqual(Object.keys(example).sort(),[...ENV_VAR_NAMES].sort());});it('is itself a valid configuration',()=>{assert.doesNotThrow(()=>loadConfig(example));});});
