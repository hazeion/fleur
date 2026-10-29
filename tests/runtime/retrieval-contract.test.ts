import { afterEach, expect, test } from "bun:test";
import { h } from "preact";
import { defineMutation, defineQuery, defineRetrieval, schema } from "../../src/schema";
import { definePage } from "../../src/routing";
import { defineDestination, handleMutation, handleQuery, handleRetrieval, readQuery, readRetrieval, registerPage, RetrievalError, type ExternalCapability } from "../../src/server";
import { executeMutation, executePage, executeQuery, executeRetrieval, nameExports } from "../../src/runtime/worker-execution";
import { makeRunner } from "../../src/runtime/worker-entry";
import { workerManifest } from "../../src/runtime/worker-manifest";
import { restoreManifest } from "../../src/runtime/manifest-wire";
import { destinationNames, destinations, mutationNames, mutations, pageNames, pages, queries, queryNames, retrievalNames, retrievals } from "../../src/runtime/registrations";
import type { ReadDb, WriteDb } from "../../src/database";

afterEach(() => { for (const map of [pages, queries, pageNames, queryNames, mutations, mutationNames, retrievals, retrievalNames, destinations, destinationNames]) map.clear(); });
const log = { info() {}, warn() {} };
const forecast = () => defineRetrieval({ name: "weather.forecast", input: schema.object({ city: schema.string() }), output: schema.object({ city: schema.string(), temperature: schema.number().nullable() }) });
const api = () => defineDestination({ name: "weather.api", origin: "https://api.weather.example", path: "/v1/forecast/:city", response: schema.object({ temperature: schema.number() }), headers: ["etag"] });

test("a retrieval handler receives only input, the external capability and a safe log", async () => {
  const contract = forecast(), destination = api();
  let keys: string[] = [];
  handleRetrieval(contract, async context => {
    keys = Object.keys(context);
    const response = await context.external.get(destination, { params: { city: context.input.city }, query: { units: "metric" } });
    return { city: context.input.city, temperature: response.body.temperature };
  });
  const sent: unknown[] = [];
  const result = await executeRetrieval("weather.forecast", { city: "Paris" }, request => { sent.push(request); return { status: 200, headers: { etag: "x" }, body: { temperature: 21 } }; }, log);
  expect(result).toEqual({ city: "Paris", temperature: 21 });
  expect(keys.sort()).toEqual(["external", "input", "log"]);
  // Application code names a declared destination; the broker receives no URL, header or secret.
  expect(sent).toEqual([{ destination: "weather.api", method: "GET", params: { city: "Paris" }, query: { units: "metric" } }]);
});

test("the capability works only during its own retrieval execution and only for declared destinations", async () => {
  const contract = forecast(), destination = api();
  let stolen: ExternalCapability | undefined;
  const undeclared = Object.freeze({ ...destination });
  handleRetrieval(contract, async ({ external, input }) => {
    stolen = external;
    for (const attempt of [
      () => external.get(undeclared as typeof destination, { params: { city: "x" } }),
      () => external.get(destination, { params: { city: "x" }, url: "http://169.254.169.254/" } as never),
      () => external.get(destination, { params: { city: "x" }, headers: { authorization: "x" } } as never),
    ]) {
      const error = await attempt().then(() => undefined, (reason: unknown) => reason);
      if (!(error instanceof RetrievalError) || error.code !== "RETRIEVAL_DESTINATION_DENIED") throw new Error("Undeclared request was not denied");
    }
    return { city: input.city, temperature: null };
  });
  const sent: unknown[] = [];
  expect(await executeRetrieval("weather.forecast", { city: "x" }, request => { sent.push(request); return {}; }, log)).toEqual({ city: "x", temperature: null });
  expect(sent).toEqual([]);
  await expect(stolen!.get(destination, { params: { city: "x" } })).rejects.toThrow("UNSUPPORTED_CAPABILITY");
});

test("queries, mutations and retrievals cannot dispatch retrievals or acquire external authority", async () => {
  const contract = forecast();
  handleRetrieval(contract, async ({ input }) => { await readRetrieval(contract, input); return { city: "x", temperature: null }; });
  const query = defineQuery({ name: "query.retrieve", input: schema.object({}), output: schema.string() });
  handleQuery(query, async () => { await readRetrieval(contract, { city: "x" }); return "x"; });
  const mutation = defineMutation({ name: "mutation.retrieve", input: schema.object({}), output: schema.string() });
  handleMutation(mutation, async () => { await readRetrieval(contract, { city: "x" }); return "x"; });
  const readsDatabase = defineRetrieval({ name: "retrieval.query", input: schema.object({}), output: schema.string() });
  handleRetrieval(readsDatabase, async () => readQuery(query, {}));
  const db = Object.freeze({}) as ReadDb;
  await expect(executeQuery("query.retrieve", {}, db, log)).rejects.toThrow("UNSUPPORTED_CAPABILITY");
  await expect(executeMutation("mutation.retrieve", {}, db as WriteDb, log)).rejects.toThrow("UNSUPPORTED_CAPABILITY");
  await expect(executeRetrieval("weather.forecast", { city: "x" }, () => ({}), log)).rejects.toThrow("UNSUPPORTED_CAPABILITY");
  await expect(executeRetrieval("retrieval.query", {}, () => ({}), log)).rejects.toThrow("UNSUPPORTED_CAPABILITY");
  // Readers of a retrieval or query cannot reach it under another operation kind.
  await expect(executeQuery("weather.forecast", { city: "x" }, db, log)).rejects.toThrow("REQUEST_DENIED");
  await expect(executeRetrieval("query.retrieve", {}, () => ({}), log)).rejects.toThrow("REQUEST_DENIED");
});

test("invalid handler output and invalid broker data are typed invalid-output failures", async () => {
  const contract = forecast(), destination = api();
  handleRetrieval(contract, async ({ external }) => {
    const response = await external.get(destination, { params: { city: "x" } });
    return { city: "x", temperature: String(response.body.temperature) } as never;
  });
  const wrongOutput = await executeRetrieval("weather.forecast", { city: "x" }, () => ({ status: 200, headers: {}, body: { temperature: 1 } }), log).catch((error: unknown) => error);
  expect(wrongOutput).toBeInstanceOf(RetrievalError);
  expect((wrongOutput as RetrievalError).code).toBe("RETRIEVAL_INVALID_OUTPUT");
  const wrongBody = await executeRetrieval("weather.forecast", { city: "x" }, () => ({ status: 200, headers: {}, body: { temperature: "hot" } }), log).catch((error: unknown) => error);
  expect((wrongBody as RetrievalError).code).toBe("RETRIEVAL_INVALID_OUTPUT");
});

test("application code handles a typed retrieval failure explicitly through the worker channel", async () => {
  const contract = forecast(), destination = api();
  handleRetrieval(contract, async ({ input, external }) => {
    try {
      const response = await external.get(destination, { params: { city: input.city } });
      return { city: input.city, temperature: response.body.temperature };
    } catch (error) {
      if (error instanceof RetrievalError && error.code === "RETRIEVAL_HTTP_FAILURE" && error.status === 503) return { city: input.city, temperature: null };
      throw error;
    }
  });
  const exports = { "shared/weather#forecast": contract, "server/weather#api": destination };
  const run = makeRunner(exports);
  const session = "00000000-0000-4000-8000-000000000001";
  const transport = (message: unknown) => {
    const request = message as { kind: string; sequence: number; value: unknown };
    if (request.kind === "registry") return { session, sequence: request.sequence, value: null };
    if (request.kind === "external") return { session, sequence: request.sequence, error: "RETRIEVAL_HTTP_FAILURE", details: { status: 503 } };
    throw new Error("unexpected");
  };
  expect(await run({ session, mode: "retrieval", operation: "weather.forecast", input: { city: "Oslo" } }, transport)).toEqual({ kind: "complete", session, sequence: 2, value: { city: "Oslo", temperature: null } });
  // Unhandled, the typed failure becomes the retrieval's own safe failure.
  const timeout = (message: unknown) => {
    const request = message as { kind: string; sequence: number };
    return request.kind === "registry" ? { session, sequence: request.sequence, value: null } : { session, sequence: request.sequence, error: "RETRIEVAL_TIMEOUT" };
  };
  expect(await run({ session, mode: "retrieval", operation: "weather.forecast", input: { city: "Oslo" } }, timeout)).toEqual({ kind: "failure", session, sequence: 2, code: "RETRIEVAL_TIMEOUT" });
});

test("server pages read retrievals, isolate an unhandled failure to its region and can render a fallback", async () => {
  const contract = forecast();
  handleRetrieval(contract, async ({ input }) => ({ city: input.city, temperature: 20 }));
  const page = definePage({ path: "/weather", params: schema.object({}) });
  async function Failing() { const value = await readRetrieval(contract, { city: "fail" }); return h("p", null, String(value.temperature)); }
  async function Fallback() {
    try { return h("p", null, String((await readRetrieval(contract, { city: "fail" })).temperature)); }
    catch (error) { return h("p", null, error instanceof RetrievalError ? `Weather unavailable (${error.code})` : "unknown"); }
  }
  registerPage(page, { component: async () => {
    const paris = await readRetrieval(contract, { city: "paris" });
    return h("main", null, h("h1", null, `${paris.city} ${paris.temperature}`), h(Failing, null), h(Fallback, null));
  } });
  nameExports({ "shared/weather#forecast": contract, "shared/pages#page": page });
  const requested: unknown[] = [];
  const result = await executePage("/weather", async () => { throw new Error("no queries"); }, async (name, input) => {
    requested.push([name, input]);
    if ((input as { city: string }).city === "fail") throw new RetrievalError("RETRIEVAL_TIMEOUT");
    return { city: "paris", temperature: 20 };
  });
  expect(result.html).toContain("<h1>paris 20</h1>");
  expect(result.html).toContain("Weather unavailable (RETRIEVAL_TIMEOUT)");
  expect(result.regions.find(region => region.error)?.error).toBe("RETRIEVAL_TIMEOUT");
  // Retrievals are not database dependencies of any region.
  expect(result.regions.flatMap(region => region.dependencies)).toEqual([]);
  expect(requested).toEqual([["weather.forecast", { city: "paris" }], ["weather.forecast", { city: "fail" }], ["weather.forecast", { city: "fail" }]]);
});

test("destination declarations are validated and round-trip through the registration manifest", () => {
  const contract = forecast(), destination = api();
  handleRetrieval(contract, async ({ input }) => ({ city: input.city, temperature: null }));
  const keyed = defineDestination({ origin: "https://api.keyed.example", path: "/v2/", response: schema.object({}), credential: "keyed" });
  const manifest = workerManifest({ "shared/weather#forecast": contract, "server/weather#api": destination, "server/weather#keyed": keyed });
  expect(manifest.destinations).toEqual([
    { id: "weather.api", origin: "https://api.weather.example", path: "/v1/forecast/:city", response: { type: "object", properties: { temperature: { type: "number" } } }, headers: ["etag"], credential: null },
    { id: "server/weather#keyed", origin: "https://api.keyed.example", path: "/v2/", response: { type: "object", properties: {} }, headers: [], credential: "keyed" },
  ]);
  const registry = restoreManifest(JSON.parse(JSON.stringify(manifest)));
  expect([...registry.retrievals.keys()]).toEqual(["weather.forecast"]);
  expect(registry.destinations.get("server/weather#keyed")).toMatchObject({ origin: "https://api.keyed.example", credential: "keyed" });
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.destinations[0].origin = "https://user:secret@api.weather.example";
  expect(() => restoreManifest(tampered)).toThrow("SOURCE_REJECTED");
  for (const options of [
    { origin: "https://user:pw@api.example", path: "/" }, { origin: "https://api.example/", path: "/" }, { origin: "https://api.example", path: "relative" },
    { origin: "https://api.example", path: "/a/../b" }, { origin: "https://api.example", path: "/", headers: ["set-cookie"] }, { origin: "https://api.example", path: "/", headers: ["Authorization"] },
    { origin: "file:///etc/passwd", path: "/" }, { origin: "https://api.example", path: "/", method: "POST" },
  ]) expect(() => defineDestination({ response: schema.object({}), ...options } as never)).toThrow();
});
