import { reconcileMaintenance } from "./recovery";
import { SQL } from "bun";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MaintenanceLease, digest, type MaintenanceMarker } from "./maintenance";
import { authorizeMaintenance, privateJson, type MaintenanceAuthority } from "./maintenance-authority";
import { backupDatabase, type BackupConfiguration } from "./backup";
import { backupManifest, verifyRetainedArchive } from "./restore-verification";
import { catalogFingerprint, migrationHistory } from "./migration-state";
import { readMigrations } from "./migration-plan";
import { dataIntegrity } from "./integrity";
import { quote } from "./inspection";
import { fileDigest, pgTool } from "./pg-tools";

export async function restoreDatabase(url:string,project:string,from:string,config:BackupConfiguration & MaintenanceAuthority={}) {
  const archive=resolve(from),manifest=backupManifest.parse(await privateJson(archive+".manifest.json"));
  const plans=await readMigrations(project);
  if(manifest.history.some((checksum,index)=>checksum!==plans[index]?.checksum))throw new Error("MIGRATION_EDITED");
  const lease=await MaintenanceLease.acquire(url,true,config,true);
  const sql=new SQL(url,{max:1,connectionTimeout:2,idleTimeout:0,maxLifetime:0});
  const frozen=join(lease.directory,`restore-${crypto.randomUUID()}.dump`),script=frozen+".sql",command=script+".psql";
  let marker:MaintenanceMarker|undefined;
  const timer=setTimeout(()=>{void sql.close({timeout:0}).catch(()=>{});void lease.close().catch(()=>{});},config.timeoutMs??60000);
  const io={timeoutMs:config.timeoutMs??60000,...(config.toolDirectory?{directory:config.toolDirectory}:{})};
  try {
    if(lease.busy)throw new Error("MAINTENANCE_BUSY");
    if(JSON.stringify(lease.target)!==JSON.stringify(manifest.target))throw new Error("BACKUP_VERIFICATION_FAILED");
    const previous=await lease.marker();
    if(previous&&!["committed","rollback verified"].includes(previous.stage))return {restored:false,...await reconcileMaintenance(url,project,config,{lease,sql})};
    if(previous&&JSON.stringify(previous.target)!==JSON.stringify(lease.target))throw new Error("RECOVERY_REQUIRED");
    const fence=await sql.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[lease.key]);
    if(!fence[0]?.acquired)throw new Error("MAINTENANCE_BUSY");
    const active=await sql.unsafe("SELECT count(*)::text AS active FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state IS DISTINCT FROM 'idle'");
    if(active[0]?.active!=="0"||(await sql.unsafe("SELECT gid FROM pg_prepared_xacts WHERE database=current_database()")).length)throw new Error("MAINTENANCE_BUSY");
    const input=await open(archive,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=await input.stat();
      if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size!==manifest.bytes)throw new Error("BACKUP_VERIFICATION_FAILED");
      const output=await open(frozen,"wx",0o600);
      try {for await(const chunk of input.createReadStream({autoClose:false}))await output.writeFile(chunk);await output.sync();}finally{await output.close();}
    }finally{await input.close();}
    if((await fileDigest(frozen)).sha256!==manifest.sha256)throw new Error("BACKUP_VERIFICATION_FAILED");
    const beforeSchema=await catalogFingerprint(sql),beforeData=await dataIntegrity(sql),beforeHistory=(await migrationHistory(sql)).map(row=>row.checksum);
    const planChecksum=digest(JSON.stringify({operation:"restore",target:lease.target,archive:manifest.sha256,beforeSchema,beforeData,beforeHistory}));
    await authorizeMaintenance(lease,{action:"restore",target:lease.target,checksum:planChecksum,replacesCurrentData:true,backup:archive},config);
    if(await catalogFingerprint(sql)!==beforeSchema||await dataIntegrity(sql)!==beforeData)throw new Error("AUTHORITY_REQUIRED");
    await pgTool("psql",["--version"],url,io);
    const intent={operation:"restore" as const,beforeSchema,beforeData,beforeHistory,afterSchema:manifest.catalogSha256,afterData:manifest.dataSha256,afterHistory:manifest.history,restoreFrom:archive};
    const preservation=await backupDatabase(url,join(lease.directory,`preserved-${crypto.randomUUID()}.dump`),config,{lease,source:sql,planChecksum,intent});
    marker=await lease.marker()??undefined;
    if(!marker)throw new Error("RECOVERY_REQUIRED");
    marker={...marker,backup:archive,intent:{...intent,preservedBackup:preservation.destination}};
    marker=await verifyRetainedArchive(url,frozen,manifest,lease,marker,config);
    await pgTool("pg_restore",["--no-owner","--no-acl","--file=-"],url,{...io,input:frozen,output:script});
    const schemas=await sql.unsafe("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema' ORDER BY nspname");
    const output=await open(command,"wx",0o600);
    try {
      await output.writeFile(`SELECT lo_unlink(oid) FROM pg_largeobject_metadata;\n${schemas.map((row:{nspname:string})=>`DROP SCHEMA ${quote(row.nspname)} CASCADE;`).join("\n")}\nCREATE SCHEMA public;\n`);
      for await(const chunk of Bun.file(script).stream())await output.writeFile(chunk);
      await output.sync();
    }finally{await output.close();}
    marker={...marker,stage:"applying"};await lease.persist(marker);await lease.assertSession();
    await pgTool("psql",["--no-psqlrc","--no-password","--single-transaction","--set=ON_ERROR_STOP=1","--file=-"],url,{...io,input:command});
    if(await catalogFingerprint(sql)!==manifest.catalogSha256||await dataIntegrity(sql)!==manifest.dataSha256||JSON.stringify((await migrationHistory(sql)).map(row=>row.checksum))!==JSON.stringify(manifest.history))throw new Error("BACKUP_VERIFICATION_FAILED");
    await lease.persist({...marker,stage:"committed",schemaState:{catalog:manifest.catalogSha256,history:manifest.history},epoch:crypto.randomUUID()});
    return {restored:true,replacesCurrentData:true,backup:archive,preservedBackup:preservation.destination,pending:plans.slice(manifest.history.length).map(plan=>plan.id)};
  }catch(error){if(marker)await lease.persist({...marker,stage:"recovery required"}).catch(()=>{});throw error;}
  finally{clearTimeout(timer);await sql.close({timeout:0});await lease.close();for(const path of [frozen,script,command])await unlink(path).catch(()=>{});}
}
