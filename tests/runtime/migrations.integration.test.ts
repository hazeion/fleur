import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function migrationCli(root: string, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), ...args, "--project", root, "--json"], { env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors).toBe("");
  return { exit, result: JSON.parse(output) };
}

test("migration commands are catalogued and reject invalid arguments before database access", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-cli-"));
  try {
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    const help = await migrationCli(root, ["--help"]);
    const names = help.result.data.commands.map((entry: { name: string }) => entry.name);
    expect(names).toContain("db migration generate");
    expect(names).toContain("db migration plan");
    expect(names).toContain("db migration apply");
    expect(names).toContain("db migration status");
    expect(names).toContain("db restore");
    const invalid = await migrationCli(root, ["db", "migration", "apply", "--yes"]);
    expect(invalid.exit).toBe(2);
    const missing = await migrationCli(root, ["db", "migration", "status"]);
    expect(missing.exit).toBe(4);
    expect(missing.result.error.code).toBe("CONFIGURATION_MISSING");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation reads server declarations into reviewable SQL and snapshots without a database", async () => {
  const { mkdir, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-generate-"));
  try {
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await mkdir(join(root, "server"));
    await writeFile(join(root, "server/tables.ts"), 'import {column,defineTable} from "fleur/database"; export const exercises=defineTable("exercises",{columns:{id:column.uuid().primaryKey(),name:column.string().max(100)}});');
    const generated = await migrationCli(root, ["db", "migration", "generate"]);
    expect(generated.exit).toBe(0);
    expect(generated.result.data.plan.statements.join("\n")).toContain('CREATE TABLE "public"."exercises"');
    expect(generated.result.data.plan.backfills).toEqual([]);
    expect(generated.result.data.plan.removals).toEqual([]);
    const saved = JSON.parse(await readFile(join(root, "migrations/0001.json"), "utf8"));
    expect(saved.snapshot[0].name).toBe("exercises");
    expect(saved.checksum).toMatch(/^[a-f0-9]{64}$/);
    const planned = await migrationCli(root, ["db", "migration", "plan"]);
    expect(planned.exit).toBe(0);
    expect(planned.result.data.migrations).toEqual([saved]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 360_000);

test("applying a reviewed migration verifies backup, commits schema/history together and blocks later catalog drift", async () => {
  const { ownedPostgres } = await import("./owned-postgres");
  const { column, defineTable } = await import("../../src/database");
  const { generateMigration } = await import("../../src/runtime/database/migration-plan");
  const { ReadBroker } = await import("../../src/runtime/database/broker");
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-apply-"));
  const table = defineTable("exercises", { columns: { id: column.uuid().primaryKey(), name: column.string().max(100) } });
  const broker = new ReadBroker({ url: fixture.url, tables: [table], maintenance: { stateRoot: root } });
  try {
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await generateMigration(root, [table]);
    const tools = await fixture.pgTools(join(root,"tools"));
    const env = { FLEUR_PRIVATE_DATABASE_URL: fixture.url, FLEUR_PRIVATE_STATE_ROOT: root, FLEUR_PRIVATE_PG_TOOLS: tools };
    const applied = await migrationCli(root, ["db","migration","apply"], env);
    expect(applied.result.error).toBeNull();
    expect(applied.exit).toBe(0);
    expect(applied.result.data.applied).toEqual(["0001"]);
    expect(applied.result.data.backup.verified).toBe(true);
    expect(await broker.read(db => db.select(table,{fields:["id","name"]}))).toEqual([]);
    const status = await migrationCli(root,["db","migration","status"],env);
    expect(status.result.data).toMatchObject({ compatible: true, applied:["0001"], pending:[] });
    await fixture.sql.unsafe("ALTER TABLE exercises ALTER COLUMN name DROP NOT NULL");
    let dispatched = false;
    await expect(broker.read(async () => { dispatched=true;return []; })).rejects.toThrow("SCHEMA_DRIFT");
    expect(dispatched).toBe(false);
    const drift = await migrationCli(root,["db","migration","status"],env);
    expect(drift.exit).toBe(5);
    expect(drift.result.error.code).toBe("SCHEMA_DRIFT");
  } finally { await broker.close(); await fixture.cleanup(); await rm(root,{recursive:true,force:true}); }
},240_000);

test("declaration changes preserve existing rows, report required backfills and refuse edited migration artifacts", async () => {
  const { column, defineTable } = await import("../../src/database");
  const { generateMigration, readMigrations } = await import("../../src/runtime/database/migration-plan");
  const { readFile } = await import("node:fs/promises");
  const root=await mkdtemp(join(tmpdir(),"fleur-migration-change-"));
  const original=defineTable("exercises",{columns:{id:column.uuid().primaryKey(),name:column.string().max(100)}});
  try {
    await generateMigration(root,[original]);
    const evolved=defineTable("exercises",{columns:{id:column.uuid().primaryKey(),name:column.string().max(200),notes:column.string().nullable(),active:column.boolean().default(true)}});
    const changed=await generateMigration(root,[evolved]);
    expect(changed.plan.incompatibilities).toEqual([]);
    expect(changed.plan.backfills).toEqual([]);
    expect(changed.plan.removals).toEqual([]);
    expect(changed.plan.statements.join("\n")).toContain("ALTER TABLE");
    expect(changed.plan.statements.join("\n")).not.toContain("DROP TABLE");
    const required=defineTable("exercises",{columns:{id:column.uuid().primaryKey(),name:column.string().max(200),notes:column.string().nullable(),active:column.boolean().default(true),required:column.string()}});
    expect((await generateMigration(root,[required])).plan.backfills).toContain("exercises.required");
    const path=join(root,"migrations/0001.json"), raw=JSON.parse(await readFile(path,"utf8"));
    raw.statements.push("CREATE INDEX CONCURRENTLY unsafe ON exercises(name)");
    await writeFile(path,JSON.stringify(raw));
    await expect(readMigrations(root)).rejects.toThrow("MIGRATION_EDITED");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("destructive plans require human authority bound to the current target and exact plan", async () => {
  const { ownedPostgres }=await import("./owned-postgres");
  const { column,defineTable }=await import("../../src/database");
  const { generateMigration }=await import("../../src/runtime/database/migration-plan");
  const { applyMigrations }=await import("../../src/runtime/database/migrations");
  const fixture=await ownedPostgres(), root=await mkdtemp(join(tmpdir(),"fleur-migration-authority-"));
  try {
    const table=defineTable("retained",{columns:{id:column.uuid().primaryKey(),name:column.string()}});
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[table]); await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("INSERT INTO retained(id,name) VALUES('11111111-1111-4111-8111-111111111111','preserved')");
    await generateMigration(root,[]);
    await expect(applyMigrations(fixture.url,root,config)).rejects.toThrow("AUTHORITY_REQUIRED");
    const requests: unknown[]=[];
    const host={...config,confirm:async(request:unknown)=>{requests.push(request);return true;}};
    const applied=await applyMigrations(fixture.url,root,host);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({action:"migration",replacesCurrentData:true});
    expect(applied.applied).toEqual(["0002"]);
    expect(await fixture.sql.unsafe("SELECT to_regclass('public.retained') AS relation")).toEqual([{relation:null}]);
  } finally {await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("confirmed restore replaces post-backup data and extra objects, verifies history and advances the external epoch", async () => {
  const {ownedPostgres}=await import("./owned-postgres");
  const {column,defineTable}=await import("../../src/database");
  const {generateMigration}=await import("../../src/runtime/database/migration-plan");
  const {applyMigrations}=await import("../../src/runtime/database/migrations");
  const {backupDatabase}=await import("../../src/runtime/database/backup");
  const {MaintenanceLease}=await import("../../src/runtime/database/maintenance");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-migration-restore-"));
  try {
    await writeFile(join(root,"fleur.json"),JSON.stringify({formatVersion:1,fleurVersion:"0.1.0",contractVersion:1,compiler:"microsoft"}));
    const table=defineTable("retained",{columns:{id:column.safeInteger().primaryKey(),name:column.string()}});
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[table]);await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("INSERT INTO public.retained VALUES(1,'backed up',1)");
    const archive=join(root,"reviewed.dump");await backupDatabase(fixture.url,archive,config);
    const before=await MaintenanceLease.acquire(fixture.url,false,config,true);
    const epoch=(await before.marker())!.epoch;await before.close();
    await fixture.sql.unsafe("UPDATE public.retained SET name='post backup'; CREATE TABLE public.extra(id integer)");
    const denied=await migrationCli(root,["db","restore","--from",archive],{FLEUR_PRIVATE_DATABASE_URL:fixture.url,FLEUR_PRIVATE_STATE_ROOT:root,FLEUR_PRIVATE_PG_TOOLS:config.toolDirectory});
    expect(denied.exit).toBe(3);
    const {restoreDatabase}=await import("../../src/runtime/database/migrations");
    const requests: unknown[]=[];
    const result=await restoreDatabase(fixture.url,root,archive,{...config,confirm:async request=>{requests.push(request);return true;}});
    expect(result.restored).toBe(true);
    expect(requests[0]).toMatchObject({action:"restore",replacesCurrentData:true,backup:archive});
    expect(await fixture.sql.unsafe("SELECT name FROM public.retained")).toEqual([{name:"backed up"}]);
    expect(await fixture.sql.unsafe("SELECT to_regclass('public.extra') AS extra")).toEqual([{extra:null}]);
    const after=await MaintenanceLease.acquire(fixture.url,false,config);
    try {expect((await after.marker())!.epoch).not.toBe(epoch);expect((await after.marker())!.stage).toBe("committed");}finally{await after.close();}
  } finally {await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

for(const stage of ["preparing","backup verified","applying","recovery required"] as const)test(`interruption at ${stage} is inspected against actual state and explicit reconciliation never replays work`,async()=>{
  const {ownedPostgres}=await import("./owned-postgres");
  const {column,defineTable}=await import("../../src/database");
  const {generateMigration}=await import("../../src/runtime/database/migration-plan");
  const {applyMigrations}=await import("../../src/runtime/database/migrations");
  const {MaintenanceLease}=await import("../../src/runtime/database/maintenance");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-migration-interrupted-"));
  try {
    await writeFile(join(root,"fleur.json"),JSON.stringify({formatVersion:1,fleurVersion:"0.1.0",contractVersion:1,compiler:"microsoft"}));
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[defineTable("once_only",{columns:{id:column.uuid().primaryKey()}})]);
    await applyMigrations(fixture.url,root,config);
    const owner=await MaintenanceLease.acquire(fixture.url,true,config);
    try {
      const completed=(await owner.marker())!;
      // Simulate PostgreSQL's rolled-back outcome and the durable stage left by a dead owner.
      await fixture.sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA fleur_internal CASCADE");
      await owner.persist({...completed,stage,intent:{...completed.intent!,afterSchema:stage==="preparing"?null:completed.intent!.afterSchema}});
    }finally{await owner.close();}
    const inspected=await migrationCli(root,["db","recover","--inspect"],{FLEUR_PRIVATE_DATABASE_URL:fixture.url,FLEUR_PRIVATE_STATE_ROOT:root});
    expect(inspected.exit).toBe(0);
    expect(inspected.result.data.classification).toBe("rollback verified");
    const stillBlocked=await MaintenanceLease.acquire(fixture.url,false,config,true);
    try{expect((await stillBlocked.marker())!.stage).toBe(stage);}finally{await stillBlocked.close();}
    await expect(MaintenanceLease.acquire(fixture.url,false,config)).rejects.toThrow("RECOVERY_REQUIRED");
    const reconciled=await applyMigrations(fixture.url,root,{...config,confirm:async()=>true});
    expect(reconciled).toMatchObject({applied:[],reconciled:"rollback verified"});
    expect(await fixture.sql.unsafe("SELECT to_regclass('public.once_only') AS relation")).toEqual([{relation:null}]);
    const ready=await MaintenanceLease.acquire(fixture.url,false,config);
    try{expect((await ready.marker())!.stage).toBe("rollback verified");}finally{await ready.close();}
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("normal admission rejects erased migration history even when application schema still matches",async()=>{
  const {ownedPostgres}=await import("./owned-postgres");
  const {column,defineTable}=await import("../../src/database");
  const {generateMigration}=await import("../../src/runtime/database/migration-plan");
  const {applyMigrations}=await import("../../src/runtime/database/migrations");
  const {ReadBroker}=await import("../../src/runtime/database/broker");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-migration-history-"));
  const table=defineTable("history_protected",{columns:{id:column.uuid().primaryKey()}});
  const broker=new ReadBroker({url:fixture.url,tables:[table],maintenance:{stateRoot:root}});
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[table]);await applyMigrations(fixture.url,root,config);
    await fixture.sql.unsafe("DELETE FROM fleur_internal.migrations");
    await expect(broker.read(db=>db.select(table,{fields:["id"]}))).rejects.toThrow("SCHEMA_DRIFT");
  }finally{await broker.close();await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("application declarations with pending migrations cannot dispatch against older schema",async()=>{
  const {ownedPostgres}=await import("./owned-postgres");
  const {column,defineTable}=await import("../../src/database");
  const {generateMigration}=await import("../../src/runtime/database/migration-plan");
  const {applyMigrations}=await import("../../src/runtime/database/migrations");
  const {ReadBroker}=await import("../../src/runtime/database/broker");
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-migration-pending-"));
  const current=defineTable("pending",{columns:{id:column.uuid().primaryKey()}}),next=defineTable("pending",{columns:{id:column.uuid().primaryKey(),notes:column.string().nullable()}});
  const broker=new ReadBroker({url:fixture.url,tables:[next],maintenance:{stateRoot:root}});
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await generateMigration(root,[current]);await applyMigrations(fixture.url,root,config);
    await expect(broker.read(async()=>[])).rejects.toThrow("MIGRATIONS_PENDING");
  }finally{await broker.close();await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);
