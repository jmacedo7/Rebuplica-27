import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after,before,describe,it } from 'node:test';
import { Client } from 'pg';
import { MIGRATIONS_DIRECTORY,applyMigrations,loadMigrations,migrationStatus } from '../../src/persistence/migrations.ts';
import { databaseSkipReason,hasDatabase,provisionDatabase,type ProvisionedDatabase } from '../helpers/database.ts';

const appliedVersions=async(url: string):Promise<readonly string[]>=>{
  const client=new Client({connectionString:url});
  await client.connect();
  try{
    const result=await client.query<{version: string}>('SELECT version FROM schema_migrations ORDER BY version ASC');
    return result.rows.map(row=>row.version);
  }finally{
    await client.end();
  }
};

describe('migration runner',()=>{
  it('discovers the repository migrations in order with stable checksums',()=>{
    const migrations=loadMigrations(MIGRATIONS_DIRECTORY);
    assert.deepEqual(migrations.map(migration=>migration.version),['0001','0002','0003']);
    assert.deepEqual(migrations.map(migration=>migration.name),['init','updated_at_trigger','integrity_and_indexes']);
    for(const migration of migrations){
      assert.match(migration.checksum,/^[0-9a-f]{64}$/u);
      assert.ok(migration.sql.length>0);
    }
    const reloaded=loadMigrations(MIGRATIONS_DIRECTORY);
    assert.deepEqual(reloaded.map(migration=>migration.checksum),migrations.map(migration=>migration.checksum));
  });
  it('ignores files that are not migrations',()=>{
    const directory=mkdtempSync(join(tmpdir(),'rebuplica-migrations-'));
    try{
      writeFileSync(join(directory,'0001_first.sql'),'SELECT 1;');
      writeFileSync(join(directory,'README.md'),'not a migration');
      writeFileSync(join(directory,'0002-second.sql'),'SELECT 2;');
      const migrations=loadMigrations(directory);
      assert.deepEqual(migrations.map(migration=>migration.version),['0001']);
    }finally{
      rmSync(directory,{recursive:true,force:true});
    }
  });
});

describe('migration runner against PostgreSQL',{skip:hasDatabase ? false : databaseSkipReason},()=>{
  let database: ProvisionedDatabase | undefined;

  before(async()=>{
    database=await provisionDatabase('migrations');
  },{timeout:120_000});

  after(async()=>{
    await database?.drop();
  });

  const url=():string=>{
    assert.ok(database,'database not provisioned');
    return database.url;
  };

  it('is idempotent and reports the applied state',async()=>{
    const report=await applyMigrations({connectionString:url(),ssl:'disable'});
    assert.deepEqual([...report.applied],[]);
    assert.deepEqual([...report.skipped],['0001','0002','0003']);
    const status=await migrationStatus({connectionString:url(),ssl:'disable'});
    assert.ok(status.every(entry=>entry.applied&&entry.checksumMatches));
    assert.ok(status.every(entry=>entry.appliedAt!==null));
  });

  it('applies and rolls back migrations inside their own transaction',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'rebuplica-synthetic-'));
    try{
      writeFileSync(join(directory,'9001_ok.sql'),'CREATE TABLE synthetic_probe (id integer PRIMARY KEY);');
      writeFileSync(join(directory,'9002_bad.sql'),'CREATE TABLE synthetic_probe (id integer PRIMARY KEY); THIS IS NOT SQL;');
      await assert.rejects(()=>applyMigrations({connectionString:url(),ssl:'disable',directory}),/9002_bad/u);
      const versions=await appliedVersions(url());
      assert.ok(versions.includes('9001'));
      assert.ok(!versions.includes('9002'),'a failed migration must not be recorded');
      const status=await migrationStatus({connectionString:url(),ssl:'disable',directory});
      assert.equal(status.find(entry=>entry.version==='9002')?.applied,false);
    }finally{
      rmSync(directory,{recursive:true,force:true});
    }
  });

  it('refuses to run when an applied migration file changed',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'rebuplica-tampered-'));
    try{
      writeFileSync(join(directory,'9500_first.sql'),'CREATE TABLE tamper_probe (id integer PRIMARY KEY);');
      const first=await applyMigrations({connectionString:url(),ssl:'disable',directory});
      assert.deepEqual([...first.applied],['9500']);
      writeFileSync(join(directory,'9500_first.sql'),'CREATE TABLE tamper_probe (id bigint PRIMARY KEY);');
      await assert.rejects(()=>applyMigrations({connectionString:url(),ssl:'disable',directory}),/changed after it was applied/u);
      const status=await migrationStatus({connectionString:url(),ssl:'disable',directory});
      assert.equal(status[0]?.checksumMatches,false);
    }finally{
      rmSync(directory,{recursive:true,force:true});
    }
  });

  it('never mutates the database while reporting the status',async()=>{
    const before=await appliedVersions(url());
    await migrationStatus({connectionString:url(),ssl:'disable'});
    const after=await appliedVersions(url());
    assert.deepEqual(after,before);
  });
});
