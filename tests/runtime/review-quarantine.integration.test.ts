import { expect, test } from "bun:test";
import { ownedPostgres } from "./owned-postgres";

test("uncertain cleanup discards reserved connections without starving healthy reads or shutdown", async () => {
  const fixture = await ownedPostgres();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await fixture.sql.unsafe("CREATE TABLE review_quarantine (id bigint PRIMARY KEY, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO review_quarantine (id) VALUES (1)");
    const running = Bun.spawn([process.execPath, "-e", `
      import { mock, spyOn } from "bun:test";
      import { CleanupLease } from "./src/runtime/database/cleanup.ts";
      import { column, defineTable } from "./src/database.ts";
      let cleanupFailures = 0, terminationFailures = 0;
      spyOn(CleanupLease.prototype, "verify").mockImplementation(async () => {
        cleanupFailures++;
        throw new Error("INJECTED_CLEANUP_UNCONFIRMED");
      });
      mock.module("./src/runtime/database/control-process.ts", () => ({ startOwnedControl: () => {
        terminationFailures++;
        return { result: Promise.resolve("failed") };
      } }));
      const { ReadBroker } = await import("./src/runtime/database/broker.ts");
      const table = defineTable("review_quarantine", { columns: { id: column.safeInteger().primaryKey() } });
      const broker = new ReadBroker({ url: process.env.FLEUR_REVIEW_PG_URL, tables: [table] });
      const reads = [];
      let failure = null, closed = false, closeTimer;
      try {
        // Six independent reads exceed all four pool slots. Each successful
        // read must retire its unverified connection without damaging the pool.
        for (let index = 0; index < 6; index++) {
          reads.push(await broker.read(db => db.select(table, { fields: ["id"] })));
        }
      } catch (error) { failure = error.message; }
      finally {
        try {
          await Promise.race([broker.close(), new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error("CLOSE_UNCONFIRMED")), 1000);
          })]);
          closed = true;
        } catch { /* Report bounded shutdown failure as test evidence. */ }
        clearTimeout(closeTimer);
      }
      console.log(JSON.stringify({ reads, failure, closed, cleanupFailures, terminationFailures }));
      // A failing shutdown must not leave the regression child alive holding
      // reservations. The parent independently owns and removes PostgreSQL.
      process.exit(0);
    `], { cwd: new URL("../..", import.meta.url).pathname, env: { ...process.env, FLEUR_REVIEW_PG_URL: fixture.url }, stdout: "pipe", stderr: "pipe" });
    child = running;
    timer = setTimeout(() => { timedOut = true; running.kill("SIGKILL"); }, 12_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited,
    ]);
    clearTimeout(timer);
    expect(timedOut).toBe(false);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const result = JSON.parse(stdout) as { reads: unknown[]; failure: string | null; closed: boolean; cleanupFailures: number; terminationFailures: number };
    expect(result.failure).toBeNull();
    expect(result.reads).toEqual(Array.from({ length: 6 }, () => [{ id: 1 }]));
    expect(result.cleanupFailures).toBe(6);
    expect(result.terminationFailures).toBe(6);
    expect(result.closed).toBe(true);
    expect(await fixture.sql.unsafe("SELECT 1 AS healthy")).toEqual([{ healthy: 1 }]);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await fixture.cleanup();
  }
}, 180_000);
