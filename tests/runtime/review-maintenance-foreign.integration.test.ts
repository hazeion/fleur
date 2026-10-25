import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase } from "../../src/runtime/database/backup";
import { ownedPostgres } from "./owned-postgres";

test("backup rejects a foreign table inside a legal pg-prefixed user schema", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-foreign-schema-"));
  try {
    await fixture.sql.unsafe("CREATE SCHEMA pgcustom; CREATE FOREIGN DATA WRAPPER review_foreign; CREATE SERVER review_server FOREIGN DATA WRAPPER review_foreign; CREATE FOREIGN TABLE pgcustom.remote_rows(id integer) SERVER review_server");
    const tools = await fixture.pgTools(join(root, "tools"));
    const destination = join(root, "rejected.dump");
    await expect(backupDatabase(fixture.url, destination, { stateRoot: root, toolDirectory: tools, timeoutMs: 120_000 })).rejects.toThrow("UNSUPPORTED_CAPABILITY");
    expect(await Bun.file(destination).exists()).toBe(false);
    expect(await Bun.file(destination+".manifest.json").exists()).toBe(false);
    expect(await fixture.sql.unsafe("SELECT datname FROM pg_database WHERE datname LIKE 'fleur_verify_%'")).toEqual([]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);
