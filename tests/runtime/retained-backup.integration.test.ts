import {expect,test} from "bun:test";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ownedPostgres} from "./owned-postgres";
import {backupDatabase} from "../../src/runtime/database/backup";
import {restoreDatabase} from "../../src/runtime/database/migrations";
import {MaintenanceLease} from "../../src/runtime/database/maintenance";

test("retained format-version-1 backups from the preceding slice remain restorable",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-legacy-backup-"));
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await fixture.sql.unsafe("CREATE TABLE public.legacy(id integer PRIMARY KEY,value text NOT NULL);INSERT INTO public.legacy VALUES(1,'retained')");
    const archive=join(root,"retained.dump");await backupDatabase(fixture.url,archive,config);
    const manifest=JSON.parse(await readFile(archive+".manifest.json","utf8"));delete manifest.catalogSha256;delete manifest.history;
    await writeFile(archive+".manifest.json",JSON.stringify(manifest));
    await fixture.sql.unsafe("UPDATE public.legacy SET value='newer'");
    expect((await restoreDatabase(fixture.url,root,archive,{...config,confirm:async()=>true})).restored).toBe(true);
    expect(await fixture.sql.unsafe("SELECT value FROM public.legacy")).toEqual([{value:"retained"}]);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);

test("fresh recovery restore verifies cleanup of an earlier interrupted verification identity before replacing its marker",async()=>{
  const fixture=await ownedPostgres(),root=await mkdtemp(join(tmpdir(),"fleur-interrupted-verification-"));
  try{
    const config={stateRoot:root,toolDirectory:await fixture.pgTools(join(root,"tools"))};
    await fixture.sql.unsafe("CREATE TABLE public.retained(id integer PRIMARY KEY);INSERT INTO public.retained VALUES(1)");
    const archive=join(root,"retained.dump");await backupDatabase(fixture.url,archive,config);
    const owner=await MaintenanceLease.acquire(fixture.url,true,config);
    const token=crypto.randomUUID().replaceAll("-",""),name=`fleur_verify_${token}`;
    try{
      const marker=(await owner.marker())!;
      const hash=new Bun.CryptoHasher("sha256").update(JSON.stringify(marker.target)).digest("hex");
      const tag=`fleur-verification-v1:${hash}:${token}`;
      await owner.persist({...marker,stage:"recovery required",verification:{token,database:name,role:name}});
      await owner.sql.unsafe(`CREATE ROLE "${name}" NOSUPERUSER NOCREATEDB NOCREATEROLE;COMMENT ON ROLE "${name}" IS '${tag}'`);
      await owner.sql.unsafe(`CREATE DATABASE "${name}" OWNER "${name}" TEMPLATE template0`);
      await owner.sql.unsafe(`COMMENT ON DATABASE "${name}" IS '${tag}'`);
    }finally{await owner.close();}
    expect((await restoreDatabase(fixture.url,root,archive,{...config,confirm:async()=>true})).restored).toBe(true);
    expect(await fixture.sql.unsafe("SELECT datname FROM pg_database WHERE datname=$1",[name])).toEqual([]);
    expect(await fixture.sql.unsafe("SELECT rolname FROM pg_roles WHERE rolname=$1",[name])).toEqual([]);
  }finally{await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},240_000);
