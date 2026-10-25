import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedPostgres } from './owned-postgres';
import { column, defineTable } from '../../src/database';
import { ReadBroker } from '../../src/runtime/database/broker';

test('independent: uninitialized migration history blocks application dispatch', async () => {
 const fixture=await ownedPostgres(), root=await mkdtemp(join(tmpdir(),'fleur-review28-'));
 const table=defineTable('unmanaged',{columns:{id:column.uuid().primaryKey()}});
 const broker=new ReadBroker({url:fixture.url,tables:[table],maintenance:{stateRoot:root}});
 let dispatched=false;
 try {
   await fixture.sql.unsafe('CREATE TABLE unmanaged(id uuid PRIMARY KEY,version bigint NOT NULL DEFAULT 1)');
   await expect(broker.read(async()=>{dispatched=true;return [];})).rejects.toThrow('MIGRATIONS_PENDING');
   expect(dispatched).toBe(false);
 } finally {await broker.close();await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},120000);

test('independent: changed recorded snapshot is rejected by migration status', async () => {
 const {generateMigration}=await import('../../src/runtime/database/migration-plan');
 const {applyMigrations,migrationStatus}=await import('../../src/runtime/database/migrations');
 const fixture=await ownedPostgres(), root=await mkdtemp(join(tmpdir(),'fleur-review28-history-'));
 try {
   const table=defineTable('recorded',{columns:{id:column.uuid().primaryKey()}});
   const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,'tools'))};
   await generateMigration(root,[table]);await applyMigrations(fixture.url,root,config);
   await fixture.sql.unsafe("UPDATE fleur_internal.migrations SET snapshot='[]'");
   await expect(migrationStatus(fixture.url,root,config)).rejects.toThrow('SCHEMA_DRIFT');
 } finally {await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},120000);
