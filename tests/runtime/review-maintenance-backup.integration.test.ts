import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { backupDatabase } from "../../src/runtime/database/backup";

function shellLiteral(value: string): string { return "'"+value.replaceAll("'", "'\\''")+"'"; }
test("a raced destination collision preserves both the unrelated destination and the verified archive", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-backup-race-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE collision_rows(id bigint PRIMARY KEY); INSERT INTO collision_rows VALUES (1)");
    const tools = await fixture.pgTools(join(root, "tools"));
    const destination = join(root, "retained.dump");
    await copyFile(join(tools, "pg_dump"), join(tools, "pg_dump.real"));
    await writeFile(join(tools, "pg_dump"), `#!/bin/sh\ncase " $* " in\n  *" --format=custom "*) printf '%s' 'unrelated destination' > ${shellLiteral(destination)} ;;\nesac\nexec ${shellLiteral(join(tools, "pg_dump.real"))} "$@"\n`, { mode: 0o700 });
    const outcome = await backupDatabase(fixture.url, destination, { stateRoot: root, toolDirectory: tools, timeoutMs: 120_000 }).then(() => "succeeded", () => "failed");
    expect(outcome).toBe("failed");
    expect(await readFile(destination, "utf8")).toBe("unrelated destination");
    const retained = (await readdir(root)).filter(name => /^retained\.dump\.[a-f0-9]{32}\.partial$/.test(name));
    expect(retained).toHaveLength(1);
    const head = await Bun.file(join(root, retained[0]!)).slice(0, 5).text();
    expect(head).toBe("PGDMP");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);
