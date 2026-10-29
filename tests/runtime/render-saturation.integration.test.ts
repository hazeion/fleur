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
// slot is still admitted, and one that timed out no longer counts as waiting.
const DEADLINE = 5000;

async function warm(app: ReadApplication): Promise<void> {
  // Every slot idle with a prepared process, so each render reserves one at
  // once and none waits for cold creation inside its own deadline.
  app.prepareWorkers();
  const ready = () => app.diagnostics().length === app.capacity && app.diagnostics().every(slot => slot.state === "idle" && slot.prepared);
  const until = performance.now() + 120_000;
  while (performance.now() < until && !ready()) await new Promise(resolve => setTimeout(resolve, 100));
  expect(app.diagnostics()).toHaveLength(app.capacity);
  for (const slot of app.diagnostics()) expect(slot).toMatchObject({ state: "idle", prepared: true });
}
const settle = (rendering: Promise<unknown>) => rendering.then(() => "rendered", (error: unknown) => error instanceof Error ? error.message : String(error));
// A nested read that needs no slot and outlives the render deadline.
const outlasting = () => new Promise<unknown>(resolve => setTimeout(() => resolve([]), DEADLINE + 1000));
// Short enough that the render and its waiting nested queries finish in time.
const brief = () => new Promise<unknown>(resolve => setTimeout(() => resolve([]), 1000));

test("nested render queries fail fast only when every slot holds a render waiting on one", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/ingredients", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE ingredients (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO ingredients (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Sage')");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    const capacity = app.capacity;
    const renders = (count: number) => Array.from({ length: count }, () => settle(app!.render("/ingredients")));
    await warm(app);

    // One render fewer than capacity leaves a slot for their nested queries.
    expect(await Promise.all(renders(capacity - 1))).toEqual(Array(capacity - 1).fill("rendered"));

    // Every slot busy, but one render waits on work that needs no slot: its
    // slot frees up, so the other renders' nested queries are admitted.
    await warm(app);
    const busy: string[] = await Promise.all([...renders(capacity - 1), settle(app.render("/ingredients", brief))]);
    expect(busy).toEqual(Array(capacity).fill("rendered"));

    // Every slot busy until the render deadlines, with fewer nested queries
    // waiting than there are slots: they keep waiting and time out. Renders
    // that stopped waiting must leave no trace, or the fresh renders below
    // would be refused with QUERY_LIMIT.
    await warm(app);
    const expired: string[] = await Promise.all([...renders(capacity - 1), settle(app.render("/ingredients", outlasting))]);
    expect(expired).toEqual(Array(capacity).fill("QUERY_TIMEOUT"));
    await warm(app);
    expect(await Promise.all(renders(capacity - 1))).toEqual(Array(capacity - 1).fill("rendered"));

    // Every slot holds a render whose nested query needs a slot of its own.
    await warm(app);
    const started = performance.now();
    const saturated = await Promise.all(renders(capacity));
    const elapsed = performance.now() - started;
    expect(saturated).toEqual(Array(capacity).fill("QUERY_LIMIT"));
    expect(elapsed).toBeLessThan(DEADLINE / 2);

    // Neither ordinary queries nor later renders are starved afterwards.
    expect(await app.query("ingredient.list", {})).toHaveLength(1);
    expect((await app.render("/ingredients")).html).toContain("Sage");
  } finally { await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
