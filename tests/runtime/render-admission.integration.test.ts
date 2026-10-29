import { expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// #57/#67: one five-second deadline covers a render's queueing, maintenance
// admission and execution. A render that cannot be admitted in time fails with
// QUERY_TIMEOUT within the deadline plus the 250-ms tolerance, even when its
// maintenance control connection stops responding.
const DEADLINE = 5000, TOLERANCE = 250;
// PostgreSQL ReadyForQuery: the connection is authenticated and idle.
const ready = Buffer.from([0x5a, 0, 0, 0, 5]);

test("render admission that outlives the render deadline reports QUERY_TIMEOUT", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/ingredients", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  const sockets = new Set<Socket>();
  let stall = false;
  const target = new URL(fixture.url);
  // Maintenance control connections pass through this proxy. Once stalled, a
  // new connection authenticates but its queries never reach PostgreSQL.
  const proxy = createServer(client => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    const stalls = stall;
    let authenticated = false;
    client.on("data", (data: Buffer) => { if (!(stalls && authenticated)) upstream.write(data); });
    upstream.on("data", (data: Buffer) => { if (data.includes(ready)) authenticated = true; client.write(data); });
    for (const [socket, peer] of [[client, upstream], [upstream, client]] as const) {
      socket.on("error", () => peer.destroy());
      socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
    }
  });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE ingredients (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewApplication(images);
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    const control = new URL(fixture.url); control.port = String(address.port); control.pathname = "/postgres";
    app = await ReadApplication.open(images, fixture.url, { controlUrl: control.href });
    // Warm every slot first, so the warm-up render and its nested queries never
    // wait for cold slot creation inside their own five-second deadline.
    app.prepareWorkers();
    const warm = performance.now() + 120_000;
    while (performance.now() < warm && !(app.diagnostics().length === 4 && app.diagnostics().every(slot => slot.state === "idle" && slot.prepared))) await new Promise(resolve => setTimeout(resolve, 100));
    expect((await app.render("/ingredients")).html).toContain("<h1>Ingredients</h1>");
    stall = true;
    const started = performance.now();
    const failure = await app.render("/ingredients").then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(DEADLINE + TOLERANCE);
  } finally {
    await app?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await fixture.cleanup(); await images.dispose();
  }
}, 300_000);
