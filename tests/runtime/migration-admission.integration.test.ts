import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { migrationStatus, applyMigrations } from "../../src/runtime/database/migrations";
import { ownedPostgres } from "./owned-postgres";
import { column, defineTable } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { catalogFingerprint } from "../../src/runtime/database/migration-state";

test("unrecorded application objects are drift for status, admission and apply", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-admission-"));
  const config = { stateRoot: root };
  try {
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, drift: false });
    await (await MaintenanceLease.acquire(fixture.url, false, config)).close();
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual([]);
    await fixture.sql.unsafe("CREATE TABLE public.unrecorded(id integer)");
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: false, drift: true });
    await expect(MaintenanceLease.acquire(fixture.url, false, config)).rejects.toThrow("SCHEMA_DRIFT");
    await expect(applyMigrations(fixture.url, root, config)).rejects.toThrow("SCHEMA_DRIFT");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("an empty complete registry rejects occupied schema even with a matching external record", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-empty-registry-"));
  const config = { stateRoot: root, tables: [], completeRegistry: true };
  try {
    await fixture.sql.unsafe("CREATE TABLE public.unrecorded(id integer)");
    const lease = await MaintenanceLease.acquire(fixture.url, true, config, true);
    try {
      await lease.persist({ formatVersion: 1, target: lease.target, stage: "committed", backup: null, planChecksum: "a".repeat(64), epoch: crypto.randomUUID(), schemaState: { catalog: await catalogFingerprint(fixture.sql), history: [] } });
    } finally { await lease.close(); }
    // The report compares recorded database state; the full registry adds a declaration-completeness gate.
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, drift: false });
    await expect(MaintenanceLease.acquire(fixture.url, false, config)).rejects.toThrow("SCHEMA_DRIFT");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("recorded catalog and history drift agree across status, admission and apply", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-migration-parity-"));
  const table = defineTable("recorded", { columns: { id: column.uuid().primaryKey(), name: column.string() } });
  const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
  const admit = async () => { await (await MaintenanceLease.acquire(fixture.url, false, { ...config, tables: [table] })).close(); };
  const compatible = async () => {
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, drift: false });
    await admit();
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual([]);
  };
  try {
    await generateMigration(root, [table]);
    await applyMigrations(fixture.url, root, config);
    const [history] = await fixture.sql.unsafe("SELECT position,id,checksum,parent_checksum,catalog,snapshot FROM fleur_internal.migrations");
    await fixture.sql.unsafe("INSERT INTO public.recorded(id,name) VALUES('11111111-1111-4111-8111-111111111111','preserved')");
    await compatible();
    for (const alteration of [
      "ALTER TABLE public.recorded ALTER COLUMN name DROP NOT NULL",
      "ALTER TABLE public.recorded ALTER COLUMN name SET DEFAULT 'unexpected'",
      "UPDATE fleur_internal.migrations SET checksum=repeat('0',64)",
      "DELETE FROM fleur_internal.migrations",
    ]) {
      await fixture.sql.unsafe(alteration);
      expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: false, drift: true });
      await expect(admit()).rejects.toThrow("SCHEMA_DRIFT");
      await expect(applyMigrations(fixture.url, root, config)).rejects.toThrow("SCHEMA_DRIFT");
      // Restore the fixture from independently retained values, never by rewriting Fleur's expected state.
      if (alteration.startsWith("ALTER")) {
        await fixture.sql.unsafe("ALTER TABLE public.recorded ALTER COLUMN name SET NOT NULL; ALTER TABLE public.recorded ALTER COLUMN name DROP DEFAULT");
      } else {
        await fixture.sql.unsafe("DELETE FROM fleur_internal.migrations");
        await fixture.sql.unsafe("INSERT INTO fleur_internal.migrations VALUES($1,$2,$3,$4,$5,$6)", [history.position, history.id, history.checksum, history.parent_checksum, history.catalog, history.snapshot]);
      }
      await compatible();
    }
    await fixture.restart();
    await compatible();
    expect(await fixture.sql.unsafe("SELECT name FROM public.recorded")).toEqual([{ name: "preserved" }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);
