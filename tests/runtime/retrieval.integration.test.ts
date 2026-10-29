import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { serveReadApplication } from "../../src/runtime/http";
import type { RetrievalConfiguration } from "../../src/runtime/retrieval/outbound";
import { ownedPostgres } from "./owned-postgres";

const secret = "fixture-weather-secret-5b1e";
async function failure(work: Promise<unknown>): Promise<Error & { status?: number }> {
  const error = await work.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  return error as Error & { status?: number };
}

test("isolated retrieval handlers obtain declared external data only through the trusted broker", async () => {
  // Controlled local provider. Requests are counted per path and credentials
  // are observed only here, on the provider side.
  const hits = new Map<string, number>(), credentials: (string | null)[] = [], slowClosed: number[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    credentials.push(request.headers.get("authorization"));
    if (path === "/v1/forecast/down") return new Response("down", { status: 503 });
    if (path === "/v1/forecast/slow") { request.signal.addEventListener("abort", () => slowClosed.push(performance.now())); return new Promise<Response>(() => {}); }
    if (path === "/v1/forecast/moved") return new Response(null, { status: 302, headers: { location: "/v1/forecast/elsewhere" } });
    return Response.json({ temperature: 20 + count, internal: "provider-internal-field" });
  } });
  // Direct worker requests would land here. It binds 0.0.0.0 so that a worker
  // with any network path to the host (loopback, bridge gateway or
  // host.docker.internal) would reach it; zero hits is the isolation proof.
  let directHits = 0;
  const canary = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch() { directHits++; return new Response("reached"); } });
  const origin = `http://weather.fixture.test:${provider.port}`;
  const directory = await mkdtemp(join(tmpdir(), "fleur-retrieval-fixture-"));
  let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined, fixture: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const savedCredentials = process.env.FLEUR_RETRIEVAL_CREDENTIALS;
  delete process.env.FLEUR_RETRIEVAL_CREDENTIALS;
  try {
    expect((await fetch(`http://127.0.0.1:${canary.port}/control`)).status).toBe(200);
    directHits = 0;
    await cp(fileURLToPath(new URL("fixtures/retrieval", import.meta.url)), directory, { recursive: true });
    for (const folder of ["server", "client", "shared"]) for (const name of await readdir(join(directory, folder))) {
      const file = join(directory, folder, name);
      await writeFile(file, (await readFile(file, "utf8")).replaceAll(":4173", `:${provider.port}`).replaceAll(":4174", `:${canary.port}`));
    }
    const project = await admitProject(directory);
    const bundle = await compileClient(project);
    const browserCode = [...bundle.files.values()].map(file => String(file.body)).join("\n");
    for (const forbidden of ["weather.fixture.test", "retrieval-server-only-canary", secret, "/v1/forecast"]) expect(browserCode).not.toContain(forbidden);
    const worker = await compileWorker(project);
    expect(worker).not.toContain(secret);
    images = await prepareNativeImages(worker);
    fixture = await ownedPostgres();
    await fixture.reviewApplication(images, true);
    // A declared credential binding must be configured before the application opens.
    expect((await failure(ReadApplication.open(images, fixture.url))).message).toBe("CONFIGURATION_MISSING");
    // The credential comes from the trusted startup environment, not configuration
    // objects or source; the worker probe below checks it never reaches workers.
    process.env.FLEUR_RETRIEVAL_CREDENTIALS = JSON.stringify({ weather: { origin, header: "authorization", value: `Bearer ${secret}` } });
    const retrieval: RetrievalConfiguration = { localServices: [origin], resolveHost: async () => ["127.0.0.1"] };
    app = await ReadApplication.open(images, fixture.url, {}, retrieval);

    const paris = await app.retrieve("weather.forecast", { city: "paris" });
    expect(paris).toEqual({ city: "paris", temperature: 21, available: true });
    expect(credentials.at(-1)).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(paris)).not.toContain("provider-internal-field");
    // The application handles a provider failure explicitly as unavailable data.
    expect(await app.retrieve("weather.forecast", { city: "down" })).toEqual({ city: "down", temperature: null, available: false });
    const http = await failure(app.retrieve("weather.strict", { city: "down" }));
    expect([http.message, http.status]).toEqual(["RETRIEVAL_HTTP_FAILURE", 503]);
    expect((await failure(app.retrieve("weather.strict", { city: "moved" }))).message).toBe("RETRIEVAL_REDIRECT_DENIED");
    expect(hits.get("/v1/forecast/elsewhere")).toBeUndefined();
    // An HTTPS destination whose name resolves to loopback is denied before connecting.
    const before = hits.get("/v1/forecast/paris");
    expect((await failure(app.retrieve("weather.rebound", {}))).message).toBe("RETRIEVAL_DESTINATION_DENIED");
    expect(hits.get("/v1/forecast/paris")).toBe(before);
    for (let repeat = 1; repeat <= 2; repeat++) {
      // The handler still runs after an external timeout and handles it explicitly.
      let started = performance.now();
      expect(await app.retrieve("weather.forecast", { city: "slow" })).toEqual({ city: "slow", temperature: null, available: false });
      expect(performance.now() - started).toBeLessThan(10_500);
      // Unhandled, the timeout is the retrieval's failure within the whole deadline.
      started = performance.now();
      expect((await failure(app.retrieve("weather.strict", { city: "slow" }))).message).toBe("RETRIEVAL_TIMEOUT");
      expect(performance.now() - started).toBeGreaterThanOrEqual(7_000);
      expect(performance.now() - started).toBeLessThan(13_000);
    }
    for (const error of [http]) expect(JSON.stringify([error.message, error.stack, Object.entries(error)])).not.toContain(secret);

    // The isolated worker has no general network access or host secrets.
    expect(await app.retrieve("network.direct", { network: false })).toEqual({ network: [], environment: false });
    // Restricted workers may reject the attempt or be terminated by the
    // native restrictions; either way no request leaves the worker.
    // Seccomp denies socket creation and thread/event creation, so Bun panics
    // starting its HTTP client thread. Depending on the kernel the process dies
    // at once (INTERNAL_FAILURE) or only at the worker operation deadline
    // (QUERY_TIMEOUT, after the guard confirms physical exit). Every outcome
    // is blocked: no request reaches the canary.
    const direct = await app.retrieve("network.direct", { network: true }).then(value => ({ value }), (error: unknown) => ({ error }));
    if ("value" in direct) expect(direct.value).toEqual({ network: ["denied", "denied", "denied"], environment: false });
    else expect(["INTERNAL_FAILURE", "QUERY_TIMEOUT"]).toContain((direct.error as Error).message);
    expect(directHits).toBe(0);
    // Handler execution beyond the worker operation deadline, with no external
    // request outstanding, is an operation timeout rather than a retrieval timeout.
    const spinning = performance.now();
    expect((await failure(app.retrieve("handler.spin", {}))).message).toBe("QUERY_TIMEOUT");
    expect(performance.now() - spinning).toBeLessThan(9_000);
    expect(await app.retrieve("weather.forecast", { city: "after-direct" })).toMatchObject({ available: true });

    // A render's nested retrieval never outlives the render: its outbound
    // request has ended, connection closed, by the time the render settles.
    const closedBefore = slowClosed.length, slowBefore = hits.get("/v1/forecast/slow") ?? 0;
    const rendering = performance.now();
    const slowRender = await app.render("/slow").then(() => "rendered", (error: unknown) => (error as Error).message);
    const settled = performance.now();
    // The retrieval normally reports its own timeout. A loaded host can leave the
    // rerun no time to start before the render deadline; the render then fails at
    // that deadline with QUERY_TIMEOUT, as docs/retrieval.md documents. Never earlier.
    expect(["RETRIEVAL_TIMEOUT", "QUERY_TIMEOUT"]).toContain(slowRender);
    if (slowRender === "QUERY_TIMEOUT") expect(settled - rendering).toBeGreaterThanOrEqual(4_900);
    expect(settled - rendering).toBeLessThan(8_000);
    // Under load the capped request deadline may already have passed when the
    // render reaches the retrieval, and then no request is made at all. A
    // request that was made must be closed by the time the render settles. The
    // provider observes the close asynchronously; a request left running after
    // the render would close only seconds later, at its own deadline.
    const made = (hits.get("/v1/forecast/slow") ?? 0) - slowBefore;
    expect(made).toBeLessThanOrEqual(1);
    const waitUntil = performance.now() + 5_000;
    while (slowClosed.length < closedBefore + made && performance.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 20));
    expect(slowClosed.length).toBe(closedBefore + made);
    if (made) expect(slowClosed.at(-1)!).toBeLessThanOrEqual(settled + 250);

    // A retrieval reached late in the render, under two seconds before its
    // deadline, still leaves its handler enough time to run after the request
    // times out: the handler sees RETRIEVAL_TIMEOUT and renders its fallback.
    expect((await app.render("/late")).html).toContain("Weather unavailable");

    // A nested retrieval runs its handler in worker slots, so its slot waits count
    // toward #90's fail-fast: when every slot holds a render whose nested
    // retrieval waits for a slot, they all fail at once with QUERY_LIMIT.
    const warm = async () => {
      app!.prepareWorkers();
      const until = performance.now() + 120_000;
      while (performance.now() < until && !(app!.diagnostics().length === app!.capacity && app!.diagnostics().every(slot => slot.state === "idle" && slot.prepared))) await new Promise(resolve => setTimeout(resolve, 100));
    };
    const renders = (count: number) => Array.from({ length: count }, () => app!.render("/weather/saturation").then(() => "rendered", (error: unknown) => (error as Error).message));
    await warm();
    const saturating = performance.now();
    expect(await Promise.all(renders(app.capacity))).toEqual(Array(app.capacity).fill("QUERY_LIMIT"));
    expect(performance.now() - saturating).toBeLessThan(2_500);
    await warm();
    expect((await app.render("/weather/saturation")).html).toContain("degrees");

    // Mutations cannot retrieve. Saving retrieved data uses a revalidating mutation.
    expect((await failure(app.mutate("readings.retrieve-inside", {}))).message).toBe("UNSUPPORTED_CAPABILITY");
    expect((await failure(app.mutate("readings.save", { city: "paris", temperature: 500 }))).message).toBe("INPUT_INVALID");
    expect(await app.mutate("readings.save", { city: "paris", temperature: 21 })).toMatchObject({ city: "paris", temperature: 21 });

    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests: string[] = [], errors: string[] = [];
    page.on("request", request => requests.push(request.url()));
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.origin + "/weather/paris");
    // A new view performs its own first load.
    await browserExpect(page.getByLabel("Temperature")).toHaveText("22 degrees");
    await browserExpect(page.getByLabel("Saved readings")).toHaveText("Saved readings: 1");
    await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
    await page.getByRole("button", { name: "Refresh weather" }).click();
    await browserExpect(page.getByLabel("Refresh status")).toHaveText("refreshed", { timeout: 20_000 });
    await browserExpect(page.getByLabel("Temperature")).toHaveText("23 degrees");
    const afterRefresh = hits.get("/v1/forecast/paris");
    // A database-driven rerender reuses the view's cached retrieval.
    await app.mutate("readings.save", { city: "paris", temperature: 23 });
    await browserExpect(page.getByLabel("Saved readings")).toHaveText("Saved readings: 2", { timeout: 10_000 });
    await browserExpect(page.getByLabel("Temperature")).toHaveText("23 degrees");
    expect(hits.get("/v1/forecast/paris")).toBe(afterRefresh);
    // The browser only talked to the Fleur server.
    expect(requests.every(url => url.startsWith(server!.url.origin))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (savedCredentials === undefined) delete process.env.FLEUR_RETRIEVAL_CREDENTIALS; else process.env.FLEUR_RETRIEVAL_CREDENTIALS = savedCredentials;
    // Each resource closes independently so one failure cannot leak the others.
    const cleanups: (() => unknown)[] = [() => browser?.close(), () => server?.stop(true), () => app?.close(), () => fixture?.cleanup(), () => images?.dispose(), () => provider.stop(true), () => canary.stop(true), () => rm(directory, { recursive: true, force: true })];
    for (const cleanup of cleanups) { try { await cleanup(); } catch (error) { console.error("retrieval fixture cleanup failed", error); } }
  }
}, 600_000);
