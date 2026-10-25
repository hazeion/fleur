import type { SQL } from "bun";
import { z } from "zod";
import { digest, type MaintenanceMarker } from "./maintenance";
import { tableDefinitions } from "../declarations";
import { describeTables, restoreTables } from "../table-wire";
import { migrationPlan, type MigrationPlan } from "./migration-plan";
import type { Table } from "../../database";

type Connection = Pick<SQL,"unsafe">;
const namespace = "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname NOT IN ('information_schema','fleur_internal')";
/** Catalog definitions, not source declarations. OIDs, data and ownership do not enter this digest. */
export async function catalogFingerprint(sql: Connection): Promise<string> {
  const definitions = [];
  const settings=await sql.unsafe("SHOW search_path");
  await sql.unsafe("SET search_path=pg_catalog");
  try {
  for (const query of [
    `SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
    `SELECT n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,co.collname,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE ${namespace} AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attname COLLATE "C"`,
    `SELECT n.nspname,c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_class c ON c.oid=k.conrelid WHERE ${namespace} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",k.conname COLLATE "C"`,
    `SELECT n.nspname,c.relname,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",pg_get_indexdef(i.indexrelid) COLLATE "C"`,
    `SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace} AND p.prokind IN ('f','p') ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
    `SELECT n.nspname,t.typname,t.typtype,t.typnotnull,format_type(t.typbasetype,t.typtypmod) AS base,t.typdefault,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_enum e ON e.enumtypid=t.oid WHERE ${namespace} AND t.typtype IN ('d','e','r') ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C",e.enumsortorder`,
    `SELECT schemaname,sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname NOT LIKE 'pg\\_%' ESCAPE '\\' AND schemaname NOT IN ('information_schema','fleur_internal') ORDER BY schemaname COLLATE "C",sequencename COLLATE "C"`,
    `SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} AND NOT t.tgisinternal ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",t.tgname COLLATE "C"`,
    `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname <> 'fleur_internal' ORDER BY schemaname COLLATE "C",tablename COLLATE "C",policyname COLLATE "C"`,
    `SELECT n.nspname,c.relname,r.rulename,pg_get_ruledef(r.oid,true) AS definition FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",r.rulename COLLATE "C"`,
    `SELECT n.nspname,t.typname,format_type(r.rngsubtype,NULL) AS subtype,format_type(r.rngmultitypid,NULL) AS multirange,r.rngcanonical::regprocedure::text AS canonical,r.rngsubdiff::regprocedure::text AS difference,co.collname,op.opcname,onsp.nspname AS operator_schema FROM pg_range r JOIN pg_type t ON t.oid=r.rngtypid JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_collation co ON co.oid=r.rngcollation JOIN pg_opclass op ON op.oid=r.rngsubopc JOIN pg_namespace onsp ON onsp.oid=op.opcnamespace WHERE ${namespace} ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C"`,
    `SELECT e.extname,e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname COLLATE "C"`,
    `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname NOT IN ('information_schema','fleur_internal') ORDER BY nspname COLLATE "C"`,
  ]) definitions.push(await sql.unsafe(query));
  return digest(JSON.stringify(definitions));
  }finally{await sql.unsafe("SELECT set_config('search_path',$1,false)",[String(settings[0].search_path)]);}
}
const historyRow = z.strictObject({ position:z.number().int().positive(), id:z.string().regex(/^\d{4}$/), checksum:z.string().regex(/^[a-f0-9]{64}$/), parent_checksum:z.string().regex(/^[a-f0-9]{64}$/).nullable(), catalog:z.string().regex(/^[a-f0-9]{64}$/), snapshot:z.string().max(1048576).transform(value=>JSON.parse(value) as unknown) });
export async function migrationHistory(sql: Connection) {
  const present = await sql.unsafe("SELECT to_regclass('fleur_internal.migrations') IS NOT NULL AS present");
  if (!present[0]?.present) return [];
  try {
    const history = z.array(historyRow).max(1000).parse(await sql.unsafe("SELECT position,id,checksum,parent_checksum,catalog,snapshot FROM fleur_internal.migrations ORDER BY position"));
    let previous:MigrationPlan|undefined;
    for (const [index,row] of history.entries()) {
      if (row.position !== index+1 || row.id !== String(index+1).padStart(4,"0") || row.parent_checksum !== (history[index-1]?.checksum ?? null)) throw new Error();
      const expected=migrationPlan(restoreTables(row.snapshot),previous);
      if(expected.checksum!==row.checksum)throw new Error();
      previous=expected;
    }
    return history;
  } catch { throw new Error("SCHEMA_DRIFT"); }
}
export async function assertMigrationState(sql: Connection, tables?: readonly Table[],completeRegistry=false) {
  const history = await migrationHistory(sql), last = history.at(-1);
  if (last) {
    if (await catalogFingerprint(sql) !== last.catalog) throw new Error("SCHEMA_DRIFT");
    if (tables && snapshotSignature(describeTables(tables)) !== snapshotSignature(describeTables(restoreTables(last.snapshot)).filter(expected=>completeRegistry||tables.some(table=>tableDefinitions.get(table)?.name===expected.name)))) throw new Error("MIGRATIONS_PENDING");
  }
  return history;
}
export async function emptyApplicationSchema(sql: Connection): Promise<boolean> {
  const rows=await sql.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace}) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace}) OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${namespace} AND t.typtype IN ('d','e','r')) AS occupied`);
  return rows[0]?.occupied === false;
}

export async function verifyExternalSchemaState(sql:Connection,marker:MaintenanceMarker|null):Promise<void> {
  if(marker?.schemaState && (await catalogFingerprint(sql)!==marker.schemaState.catalog || JSON.stringify((await migrationHistory(sql)).map(row=>row.checksum))!==JSON.stringify(marker.schemaState.history)))throw new Error("SCHEMA_DRIFT");
}

function snapshotSignature(value:unknown):string {
  const normalize=(input:unknown):unknown=>{
    if(Array.isArray(input))return input.map(normalize);
    if(input&&typeof input==="object")return Object.fromEntries(Object.entries(input).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,normalize(item)]));
    return input;
  };
  return JSON.stringify(normalize([...describeTables(restoreTables(value))].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)));
}
