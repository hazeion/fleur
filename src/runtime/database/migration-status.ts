import type { ColumnReference, Table } from "../../database";
import { definition, references, tableDefinitions } from "../declarations";
import { restoreTables } from "../table-wire";
import { caseFoldedKey, catalogTables, type CatalogTable } from "./catalog";
import { readMigrations, type MigrationPlan } from "./migration-plan";
import { readDatabaseMigrationState } from "./migration-state";
import { columnDefault, constraintName, indexKeys, tableConstraints } from "./table-ddl";
import { maintenanceSummary, type InspectionSession, type MaintenanceSummary } from "./target";

/** One observed difference from Fleur's recorded expectation. `null` means the object is absent on that side. */
export type Difference = { readonly object: string; readonly expected: string | null; readonly actual: string | null };
/** The migration summary that `db migration status` computes and `db inspect` and `status` embed unchanged. */
export type MigrationSummary = {
  readonly compatible: boolean;
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  readonly drift: boolean;
  readonly differenceCount: number;
  readonly maintenance: MaintenanceSummary;
};
export interface MigrationReport {
  readonly summary: MigrationSummary;
  readonly differences: readonly Difference[];
  readonly differencesTruncated: boolean;
  /** Validated declarations recorded with the last applied migration when history is intact; Fleur metadata for the overview. */
  readonly declarations: readonly Table[];
}
export const differenceLimit = 100;
/** Encoded bytes for the difference list, inside the page cap shared with `db inspect`. */
export const differenceBytes = 786432;

const kindTypes = { uuid: "uuid", string: "text", boolean: "boolean", safeInteger: "bigint", localDate: "date", timestamp: "timestamp with time zone" } as const;
function expectedColumn(reference: ColumnReference, managedVersion: boolean): string {
  const column = definition(reference);
  const type = column.kind === "decimal" ? `numeric(${column.precision},${column.scale})` : kindTypes[column.kind];
  const identity = columnDefault(reference, managedVersion) === null && column.generated && column.kind === "safeInteger";
  return `${type}${column.kind === "string" ? ' collate "C"' : ""}${column.nullable ? "" : " not null"}${identity ? " identity" : ""}`;
}
function actualColumn(column: CatalogTable["columns"][number]): string {
  return `${column.type}${column.collation ? ` collate "${column.collation}"` : ""}${column.nullable ? "" : " not null"}${column.identity === "a" ? " identity" : column.identity === "d" ? " identity by default" : ""}`;
}
function actualConstraint(constraint: CatalogTable["constraints"][number]): string {
  if (constraint.type === "p") return `primary key (${constraint.columns.join(", ")})`;
  if (constraint.type === "u") return `unique (${constraint.columns.join(", ")})`;
  if (constraint.type === "f") return `foreign key (${constraint.columns.join(", ")}) references ${constraint.references!.table} (${constraint.references!.columns.join(", ")}) on delete ${constraint.onDelete}`;
  return constraint.definition;
}
function actualIndex(index: CatalogTable["indexes"][number]): string {
  const folded = index.keys.length === 1 ? caseFoldedKey(index.keys[0]!) : null;
  // Fleur's keys sort nulls last in both directions, so only descending keys and nulls-first keys are annotated.
  const keys = index.keys.map((key, position) => `${key}${index.descending[position] ? " desc" : ""}${index.nullsFirst[position] ? " nulls first" : ""}`);
  return `${index.unique ? "unique" : "index"} (${folded ?? keys.join(", ")})${folded ? " case-folded" : ""}`;
}
interface Expected { readonly columns: Map<string, string>; readonly constraints: Map<string, { readonly definition: string; readonly structural: boolean }>; readonly indexes: Map<string, string> }
function expectedTables(tables: readonly Table[]): Map<string, Expected> {
  const result = new Map<string, Expected>();
  const checks = new Map(tableConstraints(tables).filter(item => item.kind === "constraint").map(item => [`${item.table}\0${item.name}`, item.sql.slice(item.sql.indexOf(`"${item.name}" `) + item.name.length + 3)]));
  for (const table of tables) {
    const spec = tableDefinitions.get(table)!;
    const expected: Expected = { columns: new Map(), constraints: new Map(), indexes: new Map() };
    for (const [field, reference] of Object.entries(spec.columns)) {
      const column = definition(reference), version = spec.versioned && field === "version";
      expected.columns.set(field, expectedColumn(reference, version));
      const check = (tag: string) => { const name = constraintName(spec.name, field, tag); expected.constraints.set(name, { definition: checks.get(`${spec.name}\0${name}`) ?? "check", structural: false }); };
      if (column.primary) expected.constraints.set(constraintName(spec.name, field, "pk"), { definition: `primary key (${field})`, structural: true });
      if (version) check("version"); else if (column.kind === "safeInteger") check("safe");
      if (column.max !== undefined) check("max");
      if (column.unique) expected.indexes.set(constraintName(spec.name, field, "unique"), `unique (${field})${column.caseFold ? " case-folded" : ""}`);
      if (column.reference) {
        const target = references.get(column.reference.target)!;
        expected.constraints.set(constraintName(spec.name, field, "fk"), { definition: `foreign key (${field}) references ${tableDefinitions.get(target.table)!.name} (${target.field}) on delete ${column.reference.onDelete}`, structural: true });
      }
    }
    for (const fields of spec.indexes) expected.indexes.set(constraintName(spec.name, indexKeys(fields), "index"), `index (${indexKeys(fields, ", ")})`);
    result.set(spec.name, expected);
  }
  return result;
}
/**
 * Structural differences between the declarations recorded with the last applied migration and the live catalog:
 * tables, column types, collations, nullability and identity, primary and foreign keys, unique and declared indexes with
 * their key order and the presence
 * of Fleur's check constraints. Other catalog changes are reported by the caller through the catalog fingerprint.
 */
export async function schemaDifferences(sql: InspectionSession["sql"], declarations: readonly Table[]): Promise<Difference[]> {
  const expected = expectedTables(declarations);
  const actual = new Map((await catalogTables(sql, null)).map(table => [table.name, table]));
  const differences: Difference[] = [];
  const compare = (object: string, want: string | undefined, have: string | undefined) => { if (want !== have) differences.push({ object, expected: want ?? null, actual: have ?? null }); };
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(name), have = actual.get(name);
    if (!want || !have) { differences.push({ object: `table ${name}`, expected: want ? `table with ${want.columns.size} columns` : null, actual: have ? `table with ${have.columns.length} columns` : null }); continue; }
    const columns = new Map(have.columns.map(column => [column.name, actualColumn(column)]));
    for (const field of new Set([...want.columns.keys(), ...columns.keys()])) compare(`column ${name}.${field}`, want.columns.get(field), columns.get(field));
    const constraints = new Map(have.constraints.map(constraint => [constraint.name, actualConstraint(constraint)]));
    for (const constraint of new Set([...want.constraints.keys(), ...constraints.keys()])) {
      const expectation = want.constraints.get(constraint), observed = constraints.get(constraint);
      if (expectation && observed !== undefined && !expectation.structural) continue;
      compare(`constraint ${name}.${constraint}`, expectation?.definition, observed);
    }
    const indexes = new Map(have.indexes.map(index => [index.name, actualIndex(index)]));
    for (const index of new Set([...want.indexes.keys(), ...indexes.keys()])) compare(`index ${name}.${index}`, want.indexes.get(index), indexes.get(index));
  }
  return differences.sort((a, b) => a.object < b.object ? -1 : a.object > b.object ? 1 : 0);
}
const historyDescription = (checksums: readonly string[]) => checksums.length ? `${checksums.length} applied migrations ending with checksum ${checksums.at(-1)}` : "no applied migrations";

/**
 * Fleur's one computation of applied, pending, drift and maintenance state for a target. It only reads: findings are
 * returned as data, never thrown. `db migration status` reports it in full; `db inspect` and `status` embed its summary.
 */
export async function readMigrationStatus(session: InspectionSession, project: string): Promise<MigrationReport> {
  const { sql, marker, lease } = session;
  const differences: Difference[] = [];
  let plans: readonly MigrationPlan[] | null = null;
  try { plans = await readMigrations(project); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "MIGRATION_EDITED") throw error;
    differences.push({ object: "migrations", expected: "committed migration files that match their reviewed plans", actual: "an edited, renamed or reordered migration file" });
  }
  const { history, catalog, expectedCatalog, recordedHistoryChanged, unrecordedObjects } = await readDatabaseMigrationState(sql, marker);
  if (!history) {
    differences.push({ object: "migration history", expected: "an ordered chain of reviewed migration checksums", actual: "an altered or unreadable migration history" });
  }
  let declarations: readonly Table[] = [];
  if (history) {
    if (plans) for (const [index, row] of history.entries()) if (row.checksum !== plans[index]?.checksum) differences.push({ object: `migration ${row.id}`, expected: `applied checksum ${row.checksum}`, actual: plans[index] ? `file checksum ${plans[index].checksum}` : "no migration file" });
    const recorded = marker?.schemaState, checksums = history.map(row => row.checksum);
    if (recorded && recordedHistoryChanged) differences.push({ object: "migration history", expected: historyDescription(recorded.history), actual: historyDescription(checksums) });
    const last = history.at(-1);
    // migrationHistory verified this snapshot against its checksum chain; restore it once through the validated path.
    declarations = restoreTables(last?.snapshot ?? []);
    if (expectedCatalog !== undefined || unrecordedObjects) {
      const structural = await schemaDifferences(sql, declarations);
      differences.push(...structural);
      if (!structural.length) differences.push({ object: "schema catalog", expected: expectedCatalog === undefined ? "an empty application schema before the first migration" : `catalog fingerprint ${expectedCatalog}`, actual: `catalog fingerprint ${catalog}` });
    }
  }
  const applied = history?.map(row => row.id) ?? [];
  const pending = history && plans ? plans.slice(history.length).map(plan => plan.id) : [];
  const maintenance = maintenanceSummary(lease.busy, marker);
  // Bounded by count and by encoded bytes; the count in the summary is always complete.
  const listed: Difference[] = [];
  let bytes = 2;
  for (const difference of differences.slice(0, differenceLimit)) {
    bytes += Buffer.byteLength(JSON.stringify(difference)) + 1;
    if (bytes > differenceBytes) break;
    listed.push(difference);
  }
  return {
    summary: { compatible: !differences.length && !pending.length && maintenance.state === "idle", applied, pending, drift: differences.length > 0, differenceCount: differences.length, maintenance },
    differences: listed,
    differencesTruncated: listed.length < differences.length,
    declarations,
  };
}
