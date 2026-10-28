import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { inspectDatabase } from "../../src/runtime/database/inspection";

test("inspection preserves numeric keyset order and accepts columns matching internal pagination names", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-inspection-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE numeric_keys (id bigint PRIMARY KEY)");
    await fixture.sql.unsafe("INSERT INTO numeric_keys VALUES (1), (2), (10), (11)");
    const observed: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await inspectDatabase(fixture.url, { project: root, table: "numeric_keys", limit: 1, ...(cursor ? { cursor } : {}) }, { stateRoot: root });
      const page = result.data as { rows: { id: string }[]; cursor: string | null };
      observed.push(...page.rows.map(row => row.id));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    expect(observed).toEqual(["1", "2", "10", "11"]);
    await fixture.sql.unsafe("CREATE TABLE internal_names (id bigint PRIMARY KEY, fleur_order text NOT NULL)");
    await fixture.sql.unsafe("INSERT INTO internal_names VALUES (1, 'preserve this column')");
    const result = await inspectDatabase(fixture.url, { project: root, table: "internal_names" }, { stateRoot: root });
    expect((result.data as { rows: unknown[] }).rows).toEqual([{ id: "1", fleur_order: "preserve this column" }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`concurrent first inspections share usable pagination keys, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-concurrent-inspection-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE shared_keys(id bigint PRIMARY KEY); INSERT INTO shared_keys VALUES (1),(2)");
    const pages = await Promise.allSettled(Array.from({ length: 24 }, () => inspectDatabase(fixture.url, { project: root, table: "shared_keys", limit: 1 }, { stateRoot: root })));
    expect(pages.filter(page => page.status === "rejected")).toEqual([]);
    for (const result of pages) {
      if (result.status !== "fulfilled") throw result.reason;
      const first = result.value.data as { cursor: string; rows: unknown[] };
      expect(first.rows).toEqual([{ id: "1" }]);
      const second = await inspectDatabase(fixture.url, { project: root, table: "shared_keys", limit: 1, cursor: first.cursor }, { stateRoot: root });
      expect((second.data as { rows: unknown[] }).rows).toEqual([{ id: "2" }]);
    }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test("a truncated table catalog supplies a cursor that reaches remaining tables", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-catalog-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE catalog_a (id bigint PRIMARY KEY)");
    await fixture.sql.unsafe("CREATE TABLE catalog_b (id bigint PRIMARY KEY)");
    const first = await inspectDatabase(fixture.url, { project: root, limit: 1 }, { stateRoot: root });
    const page = first.data as { cursor: string | null };
    expect(first.truncated).toBe(true);
    expect(page.cursor).toBeString();
    const second = await inspectDatabase(fixture.url, { project: root, limit: 1, cursor: page.cursor! }, { stateRoot: root });
    expect((second.data as { tables: { name: string }[] }).tables.map(table => table.name)).toEqual(["catalog_b"]);
    expect(second.truncated).toBe(false);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test("inspection bounds the complete encoded result including metadata", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-envelope-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE envelope_rows (id bigint PRIMARY KEY, value text NOT NULL)");
    await fixture.sql.unsafe("INSERT INTO envelope_rows VALUES (1, repeat('x', 1048540))");
    const outcome = await inspectDatabase(fixture.url, { project: root, table: "envelope_rows" }, { stateRoot: root }).then(result => ({ result }), error => ({ error: error as unknown }));
    if ("error" in outcome) {
      // A row that cannot fit in the complete result may fail with the public cap error.
      expect(outcome.error instanceof Error ? outcome.error.message : outcome.error).toBe("RESULT_TOO_LARGE");
    } else expect(Buffer.byteLength(JSON.stringify(outcome.result.data))).toBeLessThanOrEqual(1024 * 1024);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
