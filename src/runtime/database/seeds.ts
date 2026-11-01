import { columnType } from "./table-ddl";
import { projection, readValue } from "./selection";
import { SQL } from "bun";
import { requireAuthority } from "./privilege";
import type { Seed } from "../../database";
import { orderSeeds } from "../seed-declarations";
import { definition, tableDefinitions } from "../declarations";
import { MaintenanceLease, digest, type MaintenanceMarker, type MaintenanceConfiguration } from "./maintenance";
import { assertMigrationState, catalogFingerprint } from "./migration-state";
import { readMigrations } from "./migration-plan";
import { dataIntegrity } from "./integrity";
import { quote } from "./inspection";
import { writeHelpers } from "./writes";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** JSON numbers remain exact decimal text; PostgreSQL infers the declared key type. */
function databaseKey(encoded: string): string {
  const value: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  if (typeof value !== "string") throw new Error("SEED_CONFLICT");
  return value;
}
/**
 * Reconciles ordered seeds inside the caller's open READ COMMITTED transaction, which holds the maintenance fence.
 * `applying` runs after ownership and tombstones are reconciled, before the first row write. Records the resulting
 * catalog on the last applied migration and returns it with the row result.
 */
export async function reconcileSeeds(sql: Pick<SQL, "unsafe">, seeds: ReturnType<typeof orderSeeds>, applying: () => Promise<void> = async () => {}) {
  const tables = [...new Set(seeds.map(seed => seed.table))];
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS fleur_internal; CREATE TABLE IF NOT EXISTS fleur_internal.seed_ownership(seed text NOT NULL, owner_key text NOT NULL, table_name text NOT NULL, primary_field text NOT NULL, row_id text NOT NULL, fingerprint text NOT NULL, desired text NOT NULL, tombstone boolean NOT NULL DEFAULT false, PRIMARY KEY(seed,owner_key), UNIQUE(table_name,row_id))");
  const owned = await sql.unsafe("SELECT * FROM fleur_internal.seed_ownership ORDER BY seed,owner_key");
  const names = [...new Set([...tables.map(table => tableDefinitions.get(table)!.name), ...owned.map((row: { table_name: string }) => row.table_name)])].sort();
  for (const name of names) {
    const exists = await sql.unsafe("SELECT to_regclass($1) AS relation", [`public.${quote(name)}`]);
    if (exists[0]?.relation) await sql.unsafe(`LOCK TABLE public.${quote(name)} IN SHARE ROW EXCLUSIVE MODE`);
  }
  await sql.unsafe(`CREATE OR REPLACE FUNCTION public.fleur_seed_deleted_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fleur$ BEGIN UPDATE fleur_internal.seed_ownership SET tombstone=true WHERE table_name=TG_TABLE_NAME AND row_id=(to_jsonb(OLD)->TG_ARGV[0])::text; RETURN OLD; END $fleur$`);
  for (const table of tables) {
    const spec = tableDefinitions.get(table)!, primary = Object.keys(spec.columns).find(key => definition(spec.columns[key]!).primary)!;
    await sql.unsafe(`DROP TRIGGER IF EXISTS fleur_seed_delete_v1 ON public.${quote(spec.name)}`);
    await sql.unsafe(`CREATE TRIGGER fleur_seed_delete_v1 AFTER DELETE ON public.${quote(spec.name)} FOR EACH ROW EXECUTE FUNCTION public.fleur_seed_deleted_v1('${primary}')`);
  }
  for (const owner of owned) {
    const exists = await sql.unsafe("SELECT to_regclass($1) AS relation", [`public.${quote(owner.table_name)}`]);
    const row = exists[0]?.relation ? await sql.unsafe(`SELECT 1 FROM public.${quote(owner.table_name)} WHERE ${quote(owner.primary_field)}=$1`, [databaseKey(owner.row_id)]) : [];
    if (!row.length) await sql.unsafe("UPDATE fleur_internal.seed_ownership SET tombstone=true WHERE seed=$1 AND owner_key=$2", [owner.seed, owner.owner_key]);
  }
  await applying();
  const write = writeHelpers(async (text, values) => await sql.unsafe(text, values), new Set(tables));
  const result = { inserted: 0, updated: 0, skipped: [] as { seed: string; ownerKey: string; reason: string }[] };
  for (const seed of seeds) for (const row of seed.rows) {
    const spec = tableDefinitions.get(seed.table)!, primary = Object.keys(spec.columns).find(key => definition(spec.columns[key]!).primary)!;
    const values = row.values as Record<string, unknown>, desired = canonical(values);
    const owners = await sql.unsafe("SELECT * FROM fleur_internal.seed_ownership WHERE seed=$1 AND owner_key=$2 FOR UPDATE", [seed.key, row.ownerKey]);
    const owner = owners[0];
    if (owner && (owner.table_name !== spec.name || owner.primary_field !== primary)) throw new Error("SEED_CONFLICT");
    if (owner && Object.hasOwn(values, primary)) {
      const type = columnType(spec.columns[primary]!).replace(' COLLATE "C"', "");
      const normalized = await sql.unsafe(`SELECT to_jsonb($1::${type})::text AS id`, [values[primary]]);
      if (normalized[0]?.id !== owner.row_id) throw new Error("SEED_CONFLICT");
    }
    const id = owner ? databaseKey(owner.row_id) : values[primary];
    const current = id === undefined ? [] : await sql.unsafe(`SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint, ${projection(quote(primary), spec.columns[primary]!)} AS primary_value, ${spec.versioned ? 'version::text' : 'NULL::text'} AS version FROM public.${quote(spec.name)} t WHERE ${quote(primary)}=$1 FOR UPDATE`, [id]);
    if (owner?.tombstone && current.length || !owner && current.length) throw new Error("SEED_CONFLICT");
    if (owner && (owner.tombstone || !current.length || current[0].fingerprint !== owner.fingerprint)) {
      result.skipped.push({ seed: seed.key, ownerKey: row.ownerKey, reason: owner.tombstone || !current.length ? "deleted" : "user-edited" }); continue;
    }
    if (owner?.desired === desired) continue;
    let storedId = owner ? readValue(spec.columns[primary]!, current[0].primary_value, false) : id;
    if (!owner) {
      const inserted = await write.insert(seed.table, { values: row.values, returning: [primary] });
      storedId = (inserted as Record<string, unknown>)[primary]; result.inserted++;
    } else {
      const set = Object.fromEntries(Object.entries(values).filter(([name]) => name !== primary));
      if (Object.keys(set).length) {
        if (spec.versioned) await write.updateVersioned(seed.table as never, { id: storedId as never, expectedVersion: Number(current[0].version), set, returning: [primary] });
        else await write.update(seed.table as never, { id: storedId as never, set, returning: [primary] });
        result.updated++;
      }
    }
    const stored = await sql.unsafe(`SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint, to_jsonb(${quote(primary)})::text AS row_id FROM public.${quote(spec.name)} t WHERE ${quote(primary)}=$1`, [storedId]);
    await sql.unsafe("INSERT INTO fleur_internal.seed_ownership VALUES($1,$2,$3,$4,$5,$6,$7,false) ON CONFLICT(seed,owner_key) DO UPDATE SET fingerprint=excluded.fingerprint,desired=excluded.desired", [seed.key, row.ownerKey, spec.name, primary, stored[0].row_id, stored[0].fingerprint, desired]);
  }
  const catalog = await catalogFingerprint(sql);
  await sql.unsafe("UPDATE fleur_internal.migrations SET catalog=$1 WHERE position=(SELECT max(position) FROM fleur_internal.migrations)", [catalog]);
  return { result, catalog };
}
export async function seedDatabase(url: string, project: string, declarations: readonly Seed[], config: MaintenanceConfiguration = {}, held?: { lease: MaintenanceLease; sql: SQL }) {
  const seeds = orderSeeds(declarations), plans = await readMigrations(project);
  const lease = held?.lease ?? await MaintenanceLease.acquire(url, true, config, false, async (control, target) => {
    await requireAuthority(control, target, ["schema write", "schema read"]);

  });
  const sql = held?.sql ?? new SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
  const timer = setTimeout(() => { void sql.close({ timeout: 0 }).catch(() => {}); void lease.close().catch(() => {}); }, config.timeoutMs ?? 60000);
  let marker: MaintenanceMarker | undefined, transaction = false, commitAttempted = false;
  try {
    // Before any marker: seeding writes Fleur's ownership metadata, triggers and rows, and digests all data.
    await requireAuthority(lease.sql, sql, ["schema write", "schema read"]);
    const history = await assertMigrationState(sql);
    if (history.length !== plans.length || history.some((row, index) => row.checksum !== plans[index]?.checksum)) throw new Error("MIGRATIONS_PENDING");
    const tables = [...new Set(seeds.map(seed => seed.table))];
    // Compare against the entire migration registry, with no evaluation of host-side application code.
    await assertMigrationState(sql, tables);
    if (tables.length && !history.length) throw new Error("MIGRATIONS_PENDING");
    const beforeSchema = await catalogFingerprint(sql), beforeData = await dataIntegrity(sql);
    const intent = { operation: "seed" as const, beforeSchema, beforeData, beforeHistory: history.map(row => row.checksum), afterSchema: null as string | null, afterData: null as string | null, afterHistory: history.map(row => row.checksum) };
    // Refuse missing lock authority before recording any maintenance stage.
    await sql.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED"); transaction = true;
    await sql.unsafe("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'");
    await lease.fence("exclusive", sql);
    marker = { replacement: (await lease.marker())?.replacement, formatVersion: 1, target: lease.target, stage: "preparing", planChecksum: digest(canonical(seeds.map(seed => ({ key: seed.key, table: tableDefinitions.get(seed.table)!.name, rows: seed.rows, dependsOn: seed.dependsOn?.map(parent => parent.key) ?? [] })))), backup: (await lease.marker())?.backup ?? null, epoch: crypto.randomUUID(), intent };
    await lease.persist(marker);
    const { result, catalog } = await reconcileSeeds(sql, seeds, async () => { marker = { ...marker!, stage: "applying" }; await lease.persist(marker); });
    marker = { ...marker, intent: { ...intent, afterSchema: catalog, afterData: await dataIntegrity(sql) } };
    await lease.persist(marker); await lease.assertSession(); commitAttempted = true;
    await sql.unsafe("COMMIT"); transaction = false;
    await lease.persist({ ...marker, stage: "committed", schemaState: { catalog, history: intent.afterHistory }, epoch: crypto.randomUUID() });
    return result;
  } catch (error) {
    if (transaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (marker) {
      let unchanged = false;
      if (!commitAttempted) try { unchanged = await catalogFingerprint(sql) === marker.intent?.beforeSchema && await dataIntegrity(sql) === marker.intent?.beforeData; } catch { /* Preserve uncertainty. */ }
      await lease.persist({ ...marker, stage: unchanged ? "rollback verified" : "recovery required", ...(unchanged ? { schemaState: { catalog: marker.intent!.beforeSchema, history: marker.intent!.beforeHistory } } : {}) }).catch(() => {});
    }
    if (commitAttempted) throw new Error("RECOVERY_REQUIRED");
    if (error && typeof error === "object" && "code" in error && ["23503", "23505"].includes(String(error.code))) throw new Error("SEED_CONFLICT");
    throw error;
  } finally { clearTimeout(timer); if (!held) { await sql.close({ timeout: 0 }); await lease.close(); } }
}
