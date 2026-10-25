import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Table } from "../../database";
import { describeTables, restoreTables } from "../table-wire";
import { definition, tableDefinitions } from "../declarations";
import { tableDDL, tableConstraints, columnDDL, columnType, columnDefault } from "./table-ddl";
import { digest } from "./maintenance";
import { publishFile, quote } from "./inspection";

export type Snapshot = ReturnType<typeof describeTables>;
export type MigrationPlan = {
  readonly formatVersion: 1;
  readonly id: string;
  readonly parentChecksum: string | null;
  readonly snapshot: Snapshot;
  readonly statements: readonly string[];
  readonly removals: readonly string[];
  readonly incompatibilities: readonly string[];
  readonly backfills: readonly string[];
  readonly checksum: string;
};
export function migrationPlan(tables: readonly Table[], previous?: MigrationPlan): MigrationPlan {
  const snapshot = describeTables(tables);
  const before = previous?.snapshot ?? [];
  const statements: string[] = [], removals: string[] = [], incompatibilities: string[] = [], backfills: string[] = [];
  const oldTables=restoreTables(before);
  const changed=JSON.stringify(before)!==JSON.stringify(snapshot);
  if(changed) {
    const oldConstraints=tableConstraints(oldTables);
    for(const item of [...oldConstraints.filter(item=>item.kind==="foreign"),...oldConstraints.filter(item=>item.kind!=="foreign")]) statements.push(item.kind==="index"?`DROP INDEX public.${quote(item.name)}`:`ALTER TABLE public.${quote(item.table)} DROP CONSTRAINT ${quote(item.name)}`);
  }
  for(const oldTable of oldTables) {
    const old=tableDefinitions.get(oldTable)!;
    const currentTable=tables.find(table=>tableDefinitions.get(table)?.name===old.name);
    if(!currentTable) {removals.push(`table ${old.name}`);statements.push(`DROP TABLE public.${quote(old.name)}`);continue;}
    const current=tableDefinitions.get(currentTable)!;
    if(old.versioned!==current.versioned)incompatibilities.push(`Versioning changed for ${old.name}`);
    for(const [field,ref] of Object.entries(old.columns))if(!current.columns[field]) {removals.push(`${old.name}.${field}`);statements.push(`ALTER TABLE public.${quote(old.name)} DROP COLUMN ${quote(field)}`);void ref;}
    for(const [field,ref] of Object.entries(current.columns)) {
      const prior=old.columns[field],column=definition(ref),relation=`public.${quote(old.name)}`,key=quote(field);
      if(!prior) {
        if(!column.nullable&&!column.generated)backfills.push(`${old.name}.${field}`);
        statements.push(`ALTER TABLE ${relation} ADD COLUMN ${columnDDL(field,ref,current.versioned&&field==="version")}`);
        continue;
      }
      const oldColumn=definition(prior);
      if(columnType(ref)!==columnType(prior)) {
        if(column.kind!==oldColumn.kind||column.kind!=="decimal"||column.scale!==oldColumn.scale||column.precision!<oldColumn.precision!)incompatibilities.push(`Type change for ${old.name}.${field}`);
        else statements.push(`ALTER TABLE ${relation} ALTER COLUMN ${key} TYPE ${columnType(ref)}`);
      }
      if(column.managed!==oldColumn.managed)incompatibilities.push(`Generated identity changed for ${old.name}.${field}`);
      if(column.nullable!==oldColumn.nullable) {
        if(!column.nullable)backfills.push(`${old.name}.${field}`);
        statements.push(`ALTER TABLE ${relation} ALTER COLUMN ${key} ${column.nullable?"DROP":"SET"} NOT NULL`);
      }
      const fallback=columnDefault(ref,current.versioned&&field==="version");
      if(fallback!==columnDefault(prior,old.versioned&&field==="version"))statements.push(`ALTER TABLE ${relation} ALTER COLUMN ${key} ${fallback===null?"DROP DEFAULT":`SET DEFAULT ${fallback}`}`);
    }
  }
  const fullDDL=tableDDL(tables);
  for(const statement of fullDDL) {
    if(statement.startsWith("CREATE FUNCTION")&&!tableDDL(oldTables).some(old=>old.startsWith("CREATE FUNCTION")))statements.push(statement);
    else if(snapshot.filter(table=>!before.some(old=>old.name===table.name)).some(table=>statement.startsWith(`CREATE TABLE "public".${quote(table.name)} `)))statements.push(statement);
  }
  if(changed)statements.push(...tableConstraints(tables).map(item=>item.sql));
  const payload = { formatVersion: 1 as const, id: String(Number(previous?.id ?? 0)+1).padStart(4,"0"), parentChecksum: previous?.checksum ?? null, snapshot, statements, removals, incompatibilities, backfills };
  return { ...payload, checksum: digest(JSON.stringify(payload)) };
}
export async function readMigrations(project: string): Promise<readonly MigrationPlan[]> {
  const directory = join(project,"migrations");
  let files: string[];
  try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (files.length > 1000 || files.some(name => !/^[0-9]{4}\.json$/.test(name))) throw new Error("SOURCE_REJECTED");
  const plans: MigrationPlan[] = [];
  for (const name of files.sort()) {
    const text = await readFile(join(directory,name),"utf8");
    if (Buffer.byteLength(text)>1048576) throw new Error("SOURCE_REJECTED");
    const raw = JSON.parse(text) as MigrationPlan;
    const expected = migrationPlan(restoreTables(raw.snapshot), plans.at(-1));
    if (name !== expected.id+".json" || JSON.stringify(raw) !== JSON.stringify(expected)) throw new Error("MIGRATION_EDITED");
    plans.push(expected);
  }
  return plans;
}
export async function generateMigration(project: string, tables: readonly Table[]) {
  const previous = (await readMigrations(project)).at(-1);
  const plan = migrationPlan(tables, previous);
  if (previous && JSON.stringify(previous.snapshot) === JSON.stringify(plan.snapshot)) return { generated: false, plan: previous };
  await mkdir(join(project,"migrations"), { recursive: true });
  await publishFile(join(project,"migrations",plan.id+".json"), JSON.stringify(plan)+"\n");
  return { generated: true, plan };
}
