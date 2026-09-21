import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { createLogger,type LogLevel } from '../../src/api/logging.ts';

interface CapturedLine {
  readonly level: LogLevel;
  readonly record: Record<string, unknown>;
}

const capture = (): {lines: CapturedLine[]; sink: (line: string,level: LogLevel) => void} => {
  const lines: CapturedLine[] = [];
  return {
    lines,
    sink: (line,entryLevel) => { lines.push({level:entryLevel,record:JSON.parse(line) as Record<string,unknown>}); },
  };
};

describe('structured logger',()=>{
  it('emits one JSON line with timestamp, level, message and fields',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'debug',sink,context:{service:'rebuplica-27'},now:()=>new Date('2027-01-01T00:00:00.000Z')});
    logger.info('request completed',{requestId:'abc',status:200,durationMs:1.5});
    assert.equal(lines.length,1);
    const [entry]=lines;
    assert.ok(entry);
    assert.equal(entry.record['time'],'2027-01-01T00:00:00.000Z');
    assert.equal(entry.record['level'],'info');
    assert.equal(entry.record['message'],'request completed');
    assert.equal(entry.record['service'],'rebuplica-27');
    assert.equal(entry.record['status'],200);
  });
  it('respects the configured level',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'warn',sink});
    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    logger.error('kept');
    assert.deepEqual(lines.map(entry=>entry.record['message']),['kept','kept']);
    assert.deepEqual(lines.map(entry=>entry.level),['warn','error']);
  });
  it('redacts credentials, tokens and secrets',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'debug',sink});
    logger.info('login attempt',{
      email:'player@example.com',
      password:'correct horse battery staple',
      passwordHash:'scrypt$abc$def',
      nested:{accessToken:'header.payload.signature',authorization:'Bearer abc.def.ghi'},
      secret:'super-secret-value',
      jti:'0123456789abcdef',
      safe:'kept',
    });
    const [entry]=lines;
    assert.ok(entry);
    const serialised=JSON.stringify(entry.record);
    for(const forbidden of ['correct horse battery staple','scrypt$abc$def','header.payload.signature','Bearer abc.def.ghi','super-secret-value']){
      assert.ok(!serialised.includes(forbidden),`${forbidden} leaked into the logs`);
    }
    assert.equal(entry.record['safe'],'kept');
    // Correlation identifiers are not credentials: the email and the token id stay useful for debugging.
    assert.equal(entry.record['email'],'player@example.com');
    assert.equal(entry.record['jti'],'0123456789abcdef');
  });
  it('truncates deep or huge structures instead of writing megabytes',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'debug',sink});
    logger.info('payload',{items:Array.from({length:100},(_,index)=>index),deep:{a:{b:{c:{d:{e:'x'}}}}},long:'y'.repeat(2000)});
    const [entry]=lines;
    assert.ok(entry);
    assert.equal((entry.record['items'] as unknown[]).length,20);
    assert.ok(String(entry.record['long']).length<=513,String(entry.record['long']));
  });
  it('serialises errors with name and message',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'error',sink});
    logger.error('boom',{error:new TypeError('bad input')});
    const [entry]=lines;
    assert.ok(entry);
    const serialised=entry.record['error'] as Record<string,unknown>;
    assert.equal(serialised['name'],'TypeError');
    assert.equal(serialised['message'],'bad input');
  });
  it('child loggers inherit context without mutating the parent',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'debug',sink,context:{service:'api'}});
    logger.child({requestId:'r-1'}).info('child');
    logger.info('parent');
    assert.equal(lines[0]?.record['requestId'],'r-1');
    assert.equal(lines[1]?.record['requestId'],undefined);
    assert.equal(lines[1]?.record['service'],'api');
  });
  it('silent level suppresses everything',()=>{
    const { lines,sink }=capture();
    const logger=createLogger({level:'silent',sink});
    logger.error('nothing');
    assert.equal(lines.length,0);
  });
});
