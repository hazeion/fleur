import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";

for (let repeat = 1; repeat <= 2; repeat++) test(`CLI backup restores complete data, constraints, sequence and history then cleans its owned verification database, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-backup-"));
  try {
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await fixture.sql.unsafe("CREATE TABLE backup_rows(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL CHECK (length(value)>0)); INSERT INTO backup_rows(value) VALUES ('preserved'),('same'),('same'); CREATE TABLE migration_history(checksum text PRIMARY KEY); INSERT INTO migration_history VALUES ('reviewed-checksum'); CREATE TABLE backup_children(id bigint PRIMARY KEY,parent bigint REFERENCES backup_rows(id)); INSERT INTO backup_children VALUES (1,1)");
    const tools = await fixture.pgTools(join(root, "tools"));
    const destination = join(root, "retained.dump");
    const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), "db", "backup", "--out", destination, "--json", "--project", root], { env: { ...process.env, FLEUR_PRIVATE_DATABASE_URL: fixture.url, FLEUR_PRIVATE_STATE_ROOT: root, FLEUR_PRIVATE_PG_TOOLS: tools }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe("");
    const result = JSON.parse(output);
    expect(result).toMatchObject({ ok: true, command: "db backup", error: null });
    expect(exit).toBe(0);
    expect(result.data).toMatchObject({ verified: true, complete: true, cleanupVerified: true });
    const archive = new Uint8Array(await Bun.file(destination).arrayBuffer());
    expect(new TextDecoder().decode(archive.slice(0,5))).toBe("PGDMP");
    expect(result.data.sha256).toBe(new Bun.CryptoHasher("sha256").update(archive).digest("hex"));
    expect(await Bun.file(destination+".manifest.json").json()).toMatchObject({ verified: true, sha256: result.data.sha256 });
    const owned = await fixture.sql.unsafe("SELECT datname FROM pg_database WHERE datname LIKE 'fleur_verify_%'");
    expect(owned).toEqual([]);
    expect(await fixture.sql.unsafe("SELECT value FROM backup_rows ORDER BY id")).toEqual([{ value: "preserved" }, { value: "same" }, { value: "same" }]);
    expect(await fixture.sql.unsafe("SELECT rolname FROM pg_roles WHERE rolname LIKE 'fleur_verify_%'")).toEqual([]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("an incomplete restore cannot verify a backup or silently reopen application access", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-backup-failure-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE retained_original(id bigint PRIMARY KEY,value text NOT NULL); INSERT INTO retained_original VALUES(1,'untouched')");
    const tools = await fixture.pgTools(join(root, "tools"));
    // System-boundary failure: the real restoration command reports completion but restores nothing.
    await writeFile(join(tools,"pg_restore"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { backupDatabase } = await import("../../src/runtime/database/backup");
    await expect(backupDatabase(fixture.url, join(root,"failed.dump"), { stateRoot: root, toolDirectory: tools })).rejects.toThrow("BACKUP_VERIFICATION_FAILED");
    expect(await Bun.file(join(root,"failed.dump")).exists()).toBe(false);
    expect(await fixture.sql.unsafe("SELECT * FROM retained_original")).toEqual([{ id: "1", value: "untouched" }]);
    const { MaintenanceLease } = await import("../../src/runtime/database/maintenance");
    await expect(MaintenanceLease.acquire(fixture.url,false,{stateRoot:root})).rejects.toThrow("RECOVERY_REQUIRED");
    const status = await MaintenanceLease.acquire(fixture.url,false,{stateRoot:root},true);
    try {
      const marker=await status.marker();
      expect(marker?.stage).toBe("recovery required");
      expect(marker?.backup?.endsWith(".partial")).toBe(true);
      expect(await Bun.file(marker!.backup!).exists()).toBe(true);
    } finally { await status.close(); }
    expect(await fixture.sql.unsafe("SELECT datname FROM pg_database WHERE datname LIKE 'fleur_verify_%'")).toEqual([]);
    expect(await fixture.sql.unsafe("SELECT rolname FROM pg_roles WHERE rolname LIKE 'fleur_verify_%'")).toEqual([]);
  } finally { await fixture.cleanup(); await rm(root,{recursive:true,force:true}); }
},240_000);
