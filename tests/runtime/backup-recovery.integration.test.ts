import {expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ownedPostgres} from "./owned-postgres";
import {backupDatabase} from "../../src/runtime/database/backup";
import {inspectMaintenance} from "../../src/runtime/database/recovery";
import {applyMigrations} from "../../src/runtime/database/migrations";

test("an interrupted standalone backup can reconcile a proven unchanged original without another backup",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-backup-reconciliation-"));
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await fixture.sql.unsafe("CREATE TABLE public.original(id integer PRIMARY KEY,value text NOT NULL);INSERT INTO public.original VALUES(1,'unchanged')");
    await writeFile(join(config.toolDirectory,"pg_restore"),"#!/bin/sh\nexit 0\n",{mode:0o700});
    await expect(backupDatabase(fixture.url,join(root,"failed.dump"),config)).rejects.toThrow("BACKUP_VERIFICATION_FAILED");
    const inspected=await inspectMaintenance(fixture.url,config);
    expect(inspected.maintenance?.stage).toBe("recovery required");expect(inspected.classification).toBe("rollback verified");
    expect(await applyMigrations(fixture.url,root,{...config,confirm:async()=>true})).toMatchObject({applied:[],reconciled:"rollback verified"});
    expect(await fixture.sql.unsafe("SELECT value FROM public.original")).toEqual([{value:"unchanged"}]);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);
