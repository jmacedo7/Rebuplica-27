import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { ApiError } from '../../src/api/errors.ts';
import {
  isUuid,
  parseAfterVersion,
  parsePagination,
  rejectUnknownKeys,
  requireString,
  requireUuid,
  validateDecisionInput,
  validateDecisionPayload,
  validateEmail,
  validatePassword,
} from '../../src/api/validation.ts';

const GAME_ID='3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const expectApiError=(operation:()=>unknown,status:number,code:string):ApiError=>{
  try{operation();}catch(error){
    assert.ok(error instanceof ApiError,`expected ApiError, received ${String(error)}`);
    assert.equal(error.status,status);
    assert.equal(error.code,code);
    return error;
  }
  assert.fail('expected the operation to throw');
};

describe('identifier validation',()=>{
  it('accepts UUIDs only',()=>{
    assert.equal(isUuid(GAME_ID),true);
    assert.equal(isUuid('game-1'),false);
    assert.equal(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c33013'),false);
    assert.equal(requireUuid(GAME_ID,'gameId'),GAME_ID);
    expectApiError(()=>requireUuid('game-1','gameId'),400,'VALIDATION_ERROR');
  });
});

describe('string and object validation',()=>{
  it('trims strings and enforces bounds',()=>{
    assert.equal(requireString({name:'  value  '},'name'),'value');
    expectApiError(()=>requireString({},'name'),400,'VALIDATION_ERROR');
    expectApiError(()=>requireString({name:'ab'},'name',{minLength:3}),400,'VALIDATION_ERROR');
    expectApiError(()=>requireString({name:'abc'},'name',{maxLength:2}),400,'VALIDATION_ERROR');
    expectApiError(()=>requireString({name:42},'name'),400,'VALIDATION_ERROR');
  });
  it('rejects unknown properties so typos fail loudly',()=>{
    rejectUnknownKeys({email:'a@b.co',password:'x'},['email','password']);
    const error=expectApiError(()=>rejectUnknownKeys({email:'a@b.co',isAdmin:true},['email']),400,'VALIDATION_ERROR');
    assert.match(error.message,/isAdmin/);
  });
  it('normalises and validates emails',()=>{
    assert.equal(validateEmail('  Player@Example.COM '),'player@example.com');
    expectApiError(()=>validateEmail('not-an-email'),400,'INVALID_EMAIL');
    expectApiError(()=>validateEmail(`${'a'.repeat(320)}@example.com`),400,'INVALID_EMAIL');
  });
  it('only type checks passwords at the HTTP boundary',()=>{
    assert.equal(validatePassword('short'),'short');
    expectApiError(()=>validatePassword(12345),400,'VALIDATION_ERROR');
    expectApiError(()=>validatePassword('a'.repeat(201)),400,'VALIDATION_ERROR');
  });
});

describe('pagination',()=>{
  it('applies defaults and caps the page size',()=>{
    assert.deepEqual(parsePagination(new URLSearchParams('')),{limit:20,offset:0});
    assert.deepEqual(parsePagination(new URLSearchParams('limit=5&offset=10')),{limit:5,offset:10});
    assert.deepEqual(parsePagination(new URLSearchParams('limit=50'),{defaultLimit:50,maxLimit:200}),{limit:50,offset:0});
    expectApiError(()=>parsePagination(new URLSearchParams('limit=1000')),400,'VALIDATION_ERROR');
    expectApiError(()=>parsePagination(new URLSearchParams('limit=abc')),400,'VALIDATION_ERROR');
    expectApiError(()=>parsePagination(new URLSearchParams('offset=-1')),400,'VALIDATION_ERROR');
  });
  it('parses afterVersion defensively',()=>{
    assert.equal(parseAfterVersion(new URLSearchParams('')),undefined);
    assert.equal(parseAfterVersion(new URLSearchParams('afterVersion=7')),7);
    expectApiError(()=>parseAfterVersion(new URLSearchParams('afterVersion=x')),400,'VALIDATION_ERROR');
  });
});

describe('decision payload validation',()=>{
  it('accepts flat primitive payloads',()=>{
    const payload=validateDecisionPayload({key:'inflation',value:4.25,enabled:true,label:'x'});
    assert.deepEqual(payload,{key:'inflation',value:4.25,enabled:true,label:'x'});
  });
  it('rejects prototype pollution attempts',()=>{
    const hostile=JSON.parse('{"__proto__":{"polluted":true}}') as Record<string,unknown>;
    expectApiError(()=>validateDecisionPayload(hostile),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({constructor:'x'}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({prototype:1}),400,'VALIDATION_ERROR');
    assert.equal((({}) as Record<string,unknown>)['polluted'],undefined);
  });
  it('rejects keys that are not identifiers',()=>{
    expectApiError(()=>validateDecisionPayload({'not a key':1}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({0:'zero'}),400,'VALIDATION_ERROR');
  });
  it('rejects nested structures, non finite numbers and oversized values',()=>{
    expectApiError(()=>validateDecisionPayload({nested:{a:1}}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({list:[1,2]}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({value:Number.POSITIVE_INFINITY}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({value:1e13}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload({value:'x'.repeat(257)}),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionPayload(null),400,'VALIDATION_ERROR');
  });
  it('bounds the payload size and number of keys',()=>{
    const manyKeys=Object.fromEntries(Array.from({length:17},(_,index)=>[`key${index}`,1]));
    expectApiError(()=>validateDecisionPayload(manyKeys),400,'VALIDATION_ERROR');
  });
  it('validates the decision envelope against the known types',()=>{
    const input=validateDecisionInput({type:'SET_FLAG',payload:{key:'declared',value:true}},['SET_FLAG','SET_ECONOMIC_INDICATOR']);
    assert.deepEqual(input,{type:'SET_FLAG',payload:{key:'declared',value:true}});
    assert.deepEqual(validateDecisionInput({type:'SET_FLAG'},['SET_FLAG']),{type:'SET_FLAG',payload:{}});
    expectApiError(()=>validateDecisionInput({type:'DROP_TABLES',payload:{}} ,['SET_FLAG']),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionInput({type:'set_flag',payload:{}} ,['set_flag']),400,'VALIDATION_ERROR');
    expectApiError(()=>validateDecisionInput({type:'SET_FLAG',payload:{},extra:1},['SET_FLAG']),400,'VALIDATION_ERROR');
  });
});
