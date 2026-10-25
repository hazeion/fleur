import { SQL } from "bun";
import { z } from "zod";
import { MaintenanceLease, databaseUrl, digest, type MaintenanceMarker } from "./maintenance";
import { quote } from "./inspection";
import { dataIntegrity } from "./integrity";
import { catalogFingerprint, migrationHistory } from "./migration-state";
import { pgTool, fileDigest } from "./pg-tools";
import type { BackupConfiguration } from "./backup";

export const backupManifest=z.strictObject({formatVersion:z.literal(1),target:z.strictObject({cluster:z.string(),database:z.string(),oid:z.string(),owner:z.string(),address:z.string(),port:z.number()}),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive(),verified:z.literal(true),complete:z.literal(true),cleanupVerified:z.literal(true),schemaSha256:z.string(),dataSha256:z.string(),catalogSha256:z.string(),history:z.array(z.string()).max(1000),planChecksum:z.string()});
export type BackupManifest=z.infer<typeof backupManifest>;
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
export async function cleanupInterruptedVerification(lease: MaintenanceLease, marker: MaintenanceMarker): Promise<void> {
  const item=marker.verification;
  if(!item)return;
  if(!/^[a-f0-9]{32}$/.test(item.token)||item.database!==`fleur_verify_${item.token}`||item.role!==item.database||item.database===lease.target.database)throw new Error("RECOVERY_REQUIRED");
  const tag=`fleur-verification-v1:${digest(JSON.stringify(marker.target))}:${item.token}`;
  await lease.assertSession();
  const databases=await lease.sql.unsafe("SELECT d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,shobj_description(d.oid,'pg_database') AS tag FROM pg_database d WHERE datname=$1",[item.database]);
  if(databases.length) {
    if(databases.length!==1||databases[0].owner!==item.role||databases[0].tag!==tag)throw new Error("RECOVERY_REQUIRED");
    await lease.sql.unsafe(`DROP DATABASE ${quote(item.database)}`);
  }
  const roles=await lease.sql.unsafe("SELECT oid::text AS oid,shobj_description(oid,'pg_authid') AS tag FROM pg_roles WHERE rolname=$1",[item.role]);
  if(roles.length) {
    if(roles.length!==1||roles[0].tag!==tag)throw new Error("RECOVERY_REQUIRED");
    await lease.sql.unsafe(`DROP ROLE ${quote(item.role)}`);
  }
  const remaining=await lease.sql.unsafe("SELECT datname AS name FROM pg_database WHERE datname=$1 UNION ALL SELECT rolname AS name FROM pg_roles WHERE rolname=$1",[item.database]);
  if(remaining.length)throw new Error("RECOVERY_REQUIRED");
}
/** Re-verify the selected retained bytes using a new unprivileged, uniquely owned target. */
export async function verifyRetainedArchive(url:string,archive:string,manifest:BackupManifest,lease:MaintenanceLease,marker:MaintenanceMarker,config:BackupConfiguration):Promise<MaintenanceMarker> {
  const token=crypto.randomUUID().replaceAll("-",""),name=`fleur_verify_${token}`,password=crypto.randomUUID();
  const tag=`fleur-verification-v1:${digest(JSON.stringify(lease.target))}:${token}`;
  marker={...marker,verification:{database:name,role:name,token}};await lease.persist(marker);
  let sql:SQL|undefined;
  try {
    await lease.sql.unsafe("BEGIN");
    await lease.sql.unsafe(`CREATE ROLE ${quote(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    await lease.sql.unsafe(`COMMENT ON ROLE ${quote(name)} IS ${literal(tag)}`);await lease.sql.unsafe("COMMIT");
    await lease.sql.unsafe(`CREATE DATABASE ${quote(name)} OWNER ${quote(name)} TEMPLATE template0`);
    await lease.sql.unsafe(`COMMENT ON DATABASE ${quote(name)} IS ${literal(tag)}`);
    await lease.sql.unsafe(`REVOKE CONNECT ON DATABASE ${quote(name)} FROM PUBLIC`);
    const target=databaseUrl(url);target.pathname=`/${name}`;target.username=name;target.password=password;
    sql=new SQL(target.toString(),{max:1,connectionTimeout:2});
    const identity=await sql.unsafe("SELECT current_database() AS database,current_user AS role,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user");
    if(identity[0]?.database!==name||identity[0]?.role!==name||[identity[0]?.rolsuper,identity[0]?.rolcreatedb,identity[0]?.rolcreaterole,identity[0]?.rolreplication,identity[0]?.rolbypassrls].some(Boolean))throw new Error("BACKUP_VERIFICATION_FAILED");
    await pgTool("pg_restore",["--no-owner","--no-acl","--exit-on-error","--single-transaction","--no-password",`--dbname=${name}`],target.toString(),{input:archive,timeoutMs:config.timeoutMs??60000,...(config.toolDirectory?{directory:config.toolDirectory}:{})});
    await sql.unsafe("SET timezone='UTC'; SET datestyle='ISO,YMD'");
    if(await catalogFingerprint(sql)!==manifest.catalogSha256||await dataIntegrity(sql)!==manifest.dataSha256||JSON.stringify((await migrationHistory(sql)).map(row=>row.checksum))!==JSON.stringify(manifest.history))throw new Error("BACKUP_VERIFICATION_FAILED");
    if(JSON.stringify(await fileDigest(archive))!==JSON.stringify({bytes:manifest.bytes,sha256:manifest.sha256}))throw new Error("BACKUP_VERIFICATION_FAILED");
    return marker;
  } finally {
    await sql?.close({timeout:0});
    await lease.sql.unsafe("ROLLBACK").catch(()=>{});
    await cleanupInterruptedVerification(lease,marker);
  }
}
