import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";

test("concurrent inspection accepts a cursor key while its publisher syncs the directory", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-cursor-publication-"));
  try {
    await fixture.sql.unsafe("CREATE TABLE cursor_rows(id bigint PRIMARY KEY); INSERT INTO cursor_rows VALUES (1)");
    // Isolate the operating-system boundary injection from other database tests.
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import * as filesystem from "node:fs/promises";
      const originalOpen = filesystem.open;
      let reached, release;
      const paused = new Promise(resolve => { reached = resolve; });
      const resume = new Promise(resolve => { release = resolve; });
      let intercepted = false;
      mock.module("node:fs/promises", () => ({ ...filesystem, open: async (...args) => {
        const file = await originalOpen(...args);
        const originalSync = file.sync.bind(file);
        file.sync = async () => {
          const path = String(args[0]);
          if (!intercepted && (await file.stat()).isDirectory()) {
            const key = await filesystem.lstat(path+"/cursor.key").catch(() => null);
            if (key?.nlink === 2) { intercepted = true; reached(); await resume; }
          }
          return originalSync();
        };
        return file;
      }}));
      const { inspectDatabase } = await import(${JSON.stringify(resolve("src/runtime/database/inspection.ts"))});
      const { SQL } = await import("bun");
      const url = process.env.REVIEW_DATABASE_URL;
      const config = { stateRoot: process.env.REVIEW_STATE_ROOT };
      const first = inspectDatabase(url, { project: process.env.REVIEW_STATE_ROOT, table: "cursor_rows" }, config);
      await Promise.race([paused, first.then(() => { throw new Error("Missing publication pause"); })]);
      let settled = false;
      const second = inspectDatabase(url, { project: process.env.REVIEW_STATE_ROOT, table: "cursor_rows" }, config).then(
        value => { settled = true; return { value }; },
        error => { settled = true; return { error: error.message }; }
      );
      const controlUrl = new URL(url); controlUrl.pathname = "/postgres";
      const observer = new SQL(controlUrl.toString(), { max: 1 });
      try {
        const deadline = Date.now()+5000;
        while (!settled) {
          const waiting = await observer.unsafe("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted");
          if (waiting.length) break;
          if (Date.now() >= deadline) throw new Error("Second inspection neither completed nor waited for publication");
          await Bun.sleep(10);
        }
        release();
        const [a,b] = await Promise.all([first, second]);
        console.log(JSON.stringify({ first: a.data.rows, second: b }));
        if (b.error) process.exitCode = 1;
      } finally { release(); await observer.close({ timeout: 0 }); }
    `], { env: { ...process.env, REVIEW_DATABASE_URL: fixture.url, REVIEW_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe("");
    expect(output).not.toContain('"error":');
    expect(exit).toBe(0);
    expect(JSON.parse(output).first).toEqual([{ id: "1" }]);
    expect(JSON.parse(output).second.value.data.rows).toEqual([{ id: "1" }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
