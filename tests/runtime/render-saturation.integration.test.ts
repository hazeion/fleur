import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// #76: a render holds its slot while it runs, and each nested query it
// requests needs another. When every slot holds a render waiting on a nested
// query, none can be admitted before the render deadline, so those nested
// queries fail at once with QUERY_LIMIT instead of consuming the whole
// five-second budget. A render whose nested query has merely to wait for a busy
// slot is still admitted.
const DEADLINE = 5000, CAPACITY = 4;

async function warm(app: ReadApplication): Promise<void> {
  // Every slot idle with a prepared process, so each render reserves one at
  // once and none waits for cold creation inside its own deadline.
  app.prepareWorkers();
  const until = performance.now() + 120_000;
  while (performance.now() < until && !(app.diagnostics().length === CAPACITY && app.diagnostics().every(slot => slot.state === "idle" && slot.prepared))) await new Promise(resolve => setTimeout(resolve, 100));
  expect(app.diagnostics()).toHaveLength(CAPACITY);
}
const settle = (rendering: Promise<unknown>) => rendering.then(() => "rendered", (error: unknown) => error instanceof Error ? error.message : String(error));

test("nested render queries fail fast only when every slot holds a render waiting on one", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/exercises", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE exercises (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO exercises (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Squat')");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    await warm(app);

    // One render fewer than capacity leaves a slot for their nested queries.
    expect(await Promise.all(Array.from({ length: CAPACITY - 1 }, () => settle(app!.render("/exercises"))))).toEqual(Array(CAPACITY - 1).fill("rendered"));

    // Every slot busy, but one render waits on work that needs no slot: its
    // slot frees up, so the other renders' nested queries are admitted.
    await warm(app);
    const busy: string[] = await Promise.all([
      ...Array.from({ length: CAPACITY - 1 }, () => settle(app!.render("/exercises"))),
      settle(app.render("/exercises", () => new Promise(resolve => setTimeout(() => resolve([]), 1000)))),
    ]);
    expect(busy).toEqual(Array(CAPACITY).fill("rendered"));

    // Every slot holds a render whose nested query needs a slot of its own.
    await warm(app);
    const started = performance.now();
    const saturated = await Promise.all(Array.from({ length: CAPACITY }, () => settle(app!.render("/exercises"))));
    const elapsed = performance.now() - started;
    expect(saturated).toEqual(Array(CAPACITY).fill("QUERY_LIMIT"));
    expect(elapsed).toBeLessThan(DEADLINE / 2);

    // Neither ordinary queries nor later renders are starved afterwards.
    expect(await app.query("exercise.list", {})).toHaveLength(1);
    expect((await app.render("/exercises")).html).toContain("Squat");
  } finally { await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
