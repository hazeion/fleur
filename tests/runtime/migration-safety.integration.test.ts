import { expect,test } from "bun:test";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownedPostgres } from "./owned-postgres";
import { column,defineTable } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations,migrationStatus,restoreDatabase } from "../../src/runtime/database/migrations";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { backupDatabase } from "../../src/runtime/database/backup";
import { ReadBroker } from "../../src/runtime/database/broker";
import { inspectMaintenance } from "../../src/runtime/database/recovery";

test("folded uniqueness can be removed and reintroduced without duplicate helper functions",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-folded-migration-"));
  const folded=defineTable("folded",{columns:{id:column.safeInteger().primaryKey(),name:column.string().unique({caseFold:true})}});
  const ordinary=defineTable("folded",{columns:{id:column.safeInteger().primaryKey(),name:column.string().unique()}});
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[folded]);await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("INSERT INTO public.folded VALUES(1,'Straße',1)");
    await generateMigration(root,[ordinary]);await applyMigrations(fixture.url,root,config);
    await generateMigration(root,[folded]);expect((await applyMigrations(fixture.url,root,config)).applied).toEqual(["0003"]);
    await expect(Promise.resolve(fixture.sql.unsafe("INSERT INTO public.folded VALUES(2,'STRASSE',1)"))).rejects.toThrow();
    expect((await migrationStatus(fixture.url,root,config)).migrations.compatible).toBe(true);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("compatible evolution preserves rows and a failing constraint migration rolls back schema and history",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-atomic-migration-"));
  const original=defineTable("atomic_rows",{columns:{id:column.safeInteger().primaryKey(),name:column.string().max(100)}});
  const evolved=defineTable("atomic_rows",{columns:{id:column.safeInteger().primaryKey(),name:column.string().max(200),notes:column.string().nullable(),active:column.boolean().default(true)}});
  const invalid=defineTable("atomic_rows",{columns:{id:column.safeInteger().primaryKey(),name:column.string().max(2),notes:column.string().nullable(),active:column.boolean().default(true)}});
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[original]);await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("INSERT INTO public.atomic_rows VALUES(1,'Retained',1)");
    await generateMigration(root,[evolved]);await applyMigrations(fixture.url,root,config);
    expect(await fixture.sql.unsafe("SELECT name,notes,active,version FROM public.atomic_rows")).toEqual([{name:"Retained",notes:null,active:true,version:"1"}]);
    await generateMigration(root,[invalid]);await expect(applyMigrations(fixture.url,root,config)).rejects.toThrow();
    const status=(await migrationStatus(fixture.url,root,config)).migrations;
    expect(status.applied).toEqual(["0001","0002"]);expect(status.pending).toEqual(["0003"]);
    expect(status.maintenance.stage).toBe("rollback verified");
    expect(await fixture.sql.unsafe("SELECT name FROM public.atomic_rows")).toEqual([{name:"Retained"}]);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("a committed transaction with an interrupted acknowledgement reconciles without SQL replay",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-committed-migration-"));
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await fixture.sql.unsafe(`ALTER DATABASE "${new URL(fixture.url).pathname.slice(1)}" SET timezone TO 'America/Los_Angeles'`);
    await generateMigration(root,[defineTable("committed_rows",{columns:{id:column.safeInteger().primaryKey(),at:column.timestamp().defaultNow()}})]);
    await applyMigrations(fixture.url,root,config);
    const owner=await MaintenanceLease.acquire(fixture.url,true,config);
    const completed=(await owner.marker())!;
    try{await owner.persist({...completed,stage:"applying"});}finally{await owner.close();}
    expect((await inspectMaintenance(fixture.url,config)).classification).toBe("committed");
    expect(await applyMigrations(fixture.url,root,{...config,confirm:async()=>true})).toMatchObject({applied:[],reconciled:"committed"});
    const status=await migrationStatus(fixture.url,root,config);expect(status.migrations.applied).toEqual(["0001"]);expect((await inspectMaintenance(fixture.url,config)).maintenance?.epoch).not.toBe(completed.epoch);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("competing maintenance refuses restore and startup without using authority or changing data",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-competing-migration-"));
  const table=defineTable("competing",{columns:{id:column.safeInteger().primaryKey()}});
  const broker=new ReadBroker({url:fixture.url,tables:[table],maintenance:{stateRoot:root}});
  let owner:MaintenanceLease|undefined;
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[table]);await applyMigrations(fixture.url,root,config);
    const archive=join(root,"retained.dump");await backupDatabase(fixture.url,archive,config);
    owner=await MaintenanceLease.acquire(fixture.url,true,config);
    let approved=false;
    await expect(restoreDatabase(fixture.url,root,archive,{...config,confirm:async()=>{approved=true;return true;}})).rejects.toThrow("MAINTENANCE_BUSY");
    await expect(applyMigrations(fixture.url,root,config)).rejects.toThrow("MAINTENANCE_BUSY");
    await expect(broker.read(async()=>[])).rejects.toThrow("MAINTENANCE_BUSY");expect(approved).toBe(false);
    await owner.close();owner=undefined;
    expect(await broker.read(db=>db.select(table,{fields:["id"]}))).toEqual([]);
    const absentControl=new URL(fixture.url);absentControl.pathname="/missing_control_database";
    await expect(applyMigrations(fixture.url,root,{...config,controlUrl:absentControl.toString()})).rejects.toThrow("PREREQUISITE_UNAVAILABLE");
    expect(await broker.read(db=>db.select(table,{fields:["id"]}))).toEqual([]);
  }finally{await owner?.close();await broker.close();await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

for(const stage of ["preparing","applying"] as const)test(`SIGKILL during real ${stage} work retains uncertainty and never replays SQL`,async()=>{
  const {writeFile,readFile,rename}=await import("node:fs/promises");
  const {resolve}=await import("node:path");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-killed-migration-"));
  let child:ReturnType<typeof Bun.spawn>|undefined,lock:Awaited<ReturnType<typeof fixture.sql.reserve>>|undefined;
  const release=join(root,"release"),signal=join(root,"boundary"),finished=join(root,"tool-finished");
  const waitFor=async(predicate:()=>Promise<boolean>)=>{const deadline=Date.now()+10000;while(!await predicate()){if(Date.now()>=deadline)throw new Error("Owned crash boundary was not observed");await Bun.sleep(10);}};
  try{
    await writeFile(join(root,"fleur.json"),JSON.stringify({formatVersion:1,fleurVersion:"0.1.0",contractVersion:1,compiler:"microsoft"}));
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    const old=defineTable("crash_rows",{columns:{id:column.safeInteger().primaryKey()}}),next=defineTable("crash_rows",{columns:{id:column.safeInteger().primaryKey(),notes:column.string().nullable()}});
    await generateMigration(root,[old]);await applyMigrations(fixture.url,root,config);await generateMigration(root,[next]);
    const original=join(config.toolDirectory,"real-pg-dump");await rename(join(config.toolDirectory,"pg_dump"),original);
    const source=new URL(fixture.url).pathname.slice(1);
    const match=stage==="preparing"?'case "$*" in *--snapshot=*) matched=1 ;; esac':'case "$*" in *--snapshot=*) ;; *) matched=1 ;; esac';
    await writeFile(join(config.toolDirectory,"pg_dump"),`#!/bin/sh\nmatched=0\nif [ "$1" = "--schema-only" ] && [ "$PGDATABASE" = "${source}" ]; then\n${match}\nfi\nif [ "$matched" = 1 ]; then\n echo $$ > '${signal}'\n while [ ! -f '${release}' ]; do sleep 0.02; done\n ${stage==="preparing"?`: > '${finished}'; exit 1`:""}\nfi\nexec '${original}' "$@"\n`,{mode:0o700});
    child=Bun.spawn([process.execPath,resolve("bin/fleur.ts"),"db","migration","apply","--project",root,"--json"],{env:{...process.env,FLEUR_PRIVATE_DATABASE_URL:fixture.url,FLEUR_PRIVATE_STATE_ROOT:root,FLEUR_PRIVATE_PG_TOOLS:config.toolDirectory},stdout:"pipe",stderr:"pipe"});
    await waitFor(()=>Bun.file(signal).exists());
    const pid=Number((await readFile(signal,"utf8")).trim());expect(pid).toBeGreaterThan(0);
    if(stage==="applying"){
      lock=await fixture.sql.reserve();await lock.unsafe("BEGIN; LOCK TABLE public.crash_rows IN SHARE MODE");await writeFile(release,"");
      await waitFor(async()=>{const observed=await MaintenanceLease.acquire(fixture.url,false,config,true);try{return (await observed.marker())?.stage==="applying";}finally{await observed.close();}});
    }
    child.kill("SIGKILL");expect(await child.exited).not.toBe(0);child=undefined;
    if(lock){await lock.unsafe("ROLLBACK");lock.release();lock=undefined;}
    if(stage==="preparing"){await writeFile(release,"");await waitFor(()=>Bun.file(finished).exists());await waitFor(async()=>{try{process.kill(pid,0);return false;}catch{return true;}});}
    await waitFor(async()=>!(await inspectMaintenance(fixture.url,config)).busy);
    const observed=await inspectMaintenance(fixture.url,config);expect(observed.maintenance?.stage).toBe(stage);expect(observed.classification).toBe("rollback verified");
    expect(await applyMigrations(fixture.url,root,{...config,confirm:async()=>true})).toMatchObject({applied:[],reconciled:"rollback verified"});
    expect((await migrationStatus(fixture.url,root,config)).migrations.pending).toEqual(["0002"]);
  }finally{
    if(child){child.kill("SIGKILL");await child.exited;}
    if(lock){await lock.unsafe("ROLLBACK");lock.release();}
    await writeFile(release,"").catch(()=>{});await fixture.cleanup();await rm(root,{recursive:true,force:true});
  }
},240_000);

test("catalog drift catches a changed view query even when its columns remain identical",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-view-drift-"));
  const table=defineTable("view_base",{columns:{id:column.safeInteger().primaryKey()}});
  try{
    await fixture.sql.unsafe("CREATE TABLE public.view_base(id bigint PRIMARY KEY,version bigint NOT NULL DEFAULT 1); CREATE VIEW public.view_projection AS SELECT id FROM public.view_base WHERE id > 0");
    await fixture.reviewSchema([table]);
    const before=await MaintenanceLease.acquire(fixture.url,false,{stateRoot:root,tables:[table]});await before.close();
    await fixture.sql.unsafe("CREATE OR REPLACE VIEW public.view_projection AS SELECT id FROM public.view_base WHERE id > 100");
    await expect(MaintenanceLease.acquire(fixture.url,false,{stateRoot:root,tables:[table]})).rejects.toThrow("SCHEMA_DRIFT");
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("changing plan bytes during human confirmation invalidates destructive approval",async()=>{
  const {readFile,writeFile}=await import("node:fs/promises");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-changed-approval-"));
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[defineTable("approval_rows",{columns:{id:column.safeInteger().primaryKey()}})]);await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("INSERT INTO public.approval_rows VALUES(1,1)");await generateMigration(root,[]);
    await expect(applyMigrations(fixture.url,root,{...config,confirm:async()=>{
      const path=join(root,"migrations/0002.json"),plan=JSON.parse(await readFile(path,"utf8"));plan.statements.push("SELECT 1");await writeFile(path,JSON.stringify(plan));return true;
    }})).rejects.toThrow("MIGRATION_EDITED");
    expect(await fixture.sql.unsafe("SELECT id FROM public.approval_rows")).toEqual([{id:"1"}]);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);
