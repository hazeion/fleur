import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";

for (const mode of ["order", "failure"]) test(`maintenance directory durability ${mode} is established before admission`, async () => {
  const fixture = await ownedPostgres();
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-review-directory-durability-")));
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import * as filesystem from "node:fs/promises";
      const originalOpen = filesystem.open;
      const synced = [];
      mock.module("node:fs/promises", () => ({ ...filesystem, open: async (...args) => {
        const file = await originalOpen(...args);
        const originalSync = file.sync.bind(file);
        file.sync = async () => {
          const path = String(args[0]);
          if ((await file.stat()).isDirectory()) {
            synced.push(path);
            if (process.env.REVIEW_MODE === "failure" && path === process.env.REVIEW_STATE_PARENT) throw new Error("Injected directory sync failure");
          }
          return originalSync();
        };
        return file;
      }}));
      const { MaintenanceLease } = await import(${JSON.stringify(resolve("src/runtime/database/maintenance.ts"))});
      let lease, admitted = false;
      try {
        lease = await MaintenanceLease.acquire(process.env.REVIEW_DATABASE_URL, true, { stateRoot: process.env.REVIEW_STATE_PARENT+"/state/nested" });
        admitted = true;
        const beforePersist = [...synced];
        await lease.persist({ formatVersion: 1, target: lease.target, stage: "preparing", planChecksum: "a".repeat(64), backup: null, epoch: crypto.randomUUID() });
        console.log(JSON.stringify({ admitted: true, beforePersist, directory: lease.directory }));
      } catch (error) { console.log(JSON.stringify({ admitted, error: error.message, synced })); }
      finally { await lease?.close(); }
    `], { env: { ...process.env, REVIEW_DATABASE_URL: fixture.url, REVIEW_STATE_PARENT: root, REVIEW_MODE: mode }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
    const result = JSON.parse(output);
    if (mode === "failure") expect(result.admitted).toBe(false);
    else {
      expect(result.admitted).toBe(true);
      expect(result.beforePersist).toContain(root);
      expect(result.beforePersist).toContain(join(root, "state"));
      expect(result.beforePersist).toContain(join(root, "state/nested"));
      expect(result.beforePersist).toContain(result.directory);
    }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
