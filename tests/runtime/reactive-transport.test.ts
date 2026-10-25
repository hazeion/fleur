import { expect, test } from "bun:test";
import { ReactiveProject } from "../../src/runtime/reactive-project";

test("transport deduplicates canonical keys, trails invalidation, and rejects excess queries without eviction", async () => {
  let revision = "0", reads = 0;
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision }),
    validate: (_name, input) => input,
    query: async () => { reads++; return { value: revision }; },
    render: async (_path, read) => {
      await read("list", { b: 2, a: 1 });
      await read("list", { a: 1, b: 2 });
      return { html: "<main>value</main>", islands: [], regions: [] };
    },
  });
  try {
    const initial = await project.open("/one");
    expect(reads).toBe(1);
    const request = { connection: initial.connection, page: initial.page, generation: 1, sequence: 1, queries: [{ name: "list", input: { a: 1, b: 2 } }] };
    revision = "1";
    const result = await project.refresh(request);
    expect(result.revision).toBe("1");
    expect(result.queries[0]?.data).toEqual({ value: "1" });
    (result.queries[0]!.data as { value: string }).value = "local draft";
    expect((await project.refresh({ ...request, sequence: 2 })).queries[0]?.data).toEqual({ value: "1" });
    expect(reads).toBe(2);
    const excess = await project.refresh({ ...request, sequence: 3, queries: [...request.queries, ...Array.from({ length: 20 }, (_, id) => ({ name: "list", input: { id } }))] });
    expect(excess.queries.filter(query => query.error === "QUERY_LIMIT")).toHaveLength(1);
    expect(excess.queries[0]).toMatchObject({ data: { value: "1" }, stale: false });
    expect((await project.refresh({ ...request, sequence: 4 })).queries[0]?.data).toEqual({ value: "1" });
    await project.dispose(initial.connection, initial.page);
    await expect(project.refresh({ ...request, sequence: 5 })).rejects.toThrow("CONNECTION_EXPIRED");
  } finally { await project.close(); }
});

for (let repeat = 1; repeat <= 2; repeat++) test(`initial read race and trailing refresh recover the final revision without notifications, repeat ${repeat}`, async () => {
  let revision = "0", duringRead = true;
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision }),
    validate: (_name, input) => input,
    query: async () => { const result = revision; if (duringRead) { revision = "1"; duringRead = false; } return result; },
    render: async (_path, read) => ({ html: String(await read("value", {})), islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/race");
    expect(initial.status).toBe("stale");
    expect(initial.rendered.html).toBe("0");
    const next = await project.refresh({ connection: initial.connection, page: initial.page, generation: 1, sequence: 1, queries: [{ name: "value", input: {} }] });
    expect(next.status).toBe("current");
    expect(next.rendered.html).toBe("1");
    expect(next.queries[0]?.data).toBe("1");
    revision = "2";
    const final = await project.refresh({ connection: initial.connection, page: initial.page, generation: 1, sequence: 2, queries: [{ name: "value", input: {} }] });
    expect(final.rendered.html).toBe("2");
  } finally { await project.close(); }
});

test("refresh failures retain stale data, isolate siblings, and reconnect rereads every query", async () => {
  let revision = "0", fail = false, reads = 0;
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision }),
    validate: (_name, input) => input,
    query: async name => { reads++; if (name === "bad" && fail) throw new Error("QUERY_TIMEOUT"); return name + revision; },
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/failures");
    const request = { connection: initial.connection, page: initial.page, generation: 1, sequence: 1, queries: [{ name: "bad", input: {} }, { name: "healthy", input: {} }] };
    expect((await project.refresh(request)).queries.map(query => query.data)).toEqual(["bad0", "healthy0"]);
    revision = "1"; fail = true;
    const result = await project.refresh({ ...request, sequence: 2 });
    expect(result.queries[0]).toMatchObject({ data: "bad0", stale: true, status: "error", error: "QUERY_TIMEOUT" });
    expect(result.queries[1]).toMatchObject({ data: "healthy1", stale: false, status: "current" });
    const beforeReconnect = reads;
    fail = false;
    await project.refresh({ ...request, generation: 2, sequence: 3 });
    expect(reads - beforeReconnect).toBe(2);
    await expect(project.refresh({ ...request, sequence: 4 })).rejects.toThrow("RESPONSE_OBSOLETE");
  } finally { await project.close(); }
});

test("project cap counts logical keys per connection and disposal releases capacity", async () => {
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }),
    validate: (_name, input) => input, query: async () => "result",
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  const queries = Array.from({ length: 20 }, (_, id) => ({ name: "query", input: { id } }));
  try {
    const connections = [];
    for (let index = 0; index < 5; index++) {
      const connection = await project.open("/cap"); connections.push(connection);
      await project.refresh({ ...connection, generation: 1, sequence: 1, queries });
    }
    const extra = await project.open("/cap");
    expect((await project.refresh({ ...extra, generation: 1, sequence: 1, queries: [queries[0]!] })).queries[0]).toMatchObject({ status: "error", error: "QUERY_LIMIT" });
    await project.dispose(connections[0]!.connection, connections[0]!.page);
    expect((await project.refresh({ ...extra, generation: 1, sequence: 2, queries })).queries).toHaveLength(20);
    expect((await project.refresh({ ...connections[1]!, generation: 1, sequence: 2, queries })).queries).toHaveLength(20);
  } finally { await project.close(); }
});

test("epoch changes discard in-flight results even when a restored revision is lower", async () => {
  let epoch = "00000000-0000-4000-8000-000000000000", change = false, revision = "10";
  const project = new ReactiveProject({
    revision: async () => ({ epoch, revision }), validate: (_name, input) => input,
    query: async () => { if (change) { epoch = "00000000-0000-4000-8000-000000000001"; revision = "0"; change = false; } return "result"; },
    render: async (_path, read) => ({ html: String(await read("value", {})), islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/epoch");
    change = true;
    await expect(project.refresh({ ...initial, generation: 1, sequence: 1, queries: [] })).rejects.toThrow("MAINTENANCE_BUSY");
    expect(await project.refresh({ ...initial, generation: 2, sequence: 2, queries: [] })).toMatchObject({ epoch, revision: "0", status: "current" });
  } finally { await project.close(); }
});

test("initial server dependencies execute outside the restricted render deadline", async () => {
  let rendering = false, queriedDuringRender = false;
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }), validate: (_name, input) => input,
    query: async () => { queriedDuringRender ||= rendering; return "real validated data"; },
    render: async (_path, read) => {
      rendering = true;
      try { return { html: String(await read("value", {})), islands: [], regions: [] }; }
      finally { rendering = false; }
    },
  });
  try {
    expect((await project.open("/deadline")).rendered.html).toBe("real validated data");
    expect(queriedDuringRender).toBe(false);
  } finally { await project.close(); }
});

test("a pending slow query does not withhold a healthy sibling's complete result", async () => {
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }), validate: (_name, input) => input,
    query: async name => { if (name === "slow") await slow; return name; },
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/siblings");
    const response = project.refresh({ ...initial, sequence: 1, queries: [{ name: "slow", input: {} }, { name: "healthy", input: {} }] });
    const result = await Promise.race([response, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(result).not.toBeNull();
    expect(result?.queries[1]).toMatchObject({ data: "healthy", stale: false, status: "current" });
  } finally { release(); await project.close(); }
});

test("server rendering cannot delay independently completed island query results", async () => {
  let revision = "0", block = false, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision }), validate: (_name, input) => input,
    query: async () => revision,
    render: async (_path, read) => { if (block) await waiting; return { html: String(await read("value", {})), islands: [], regions: [] }; },
  });
  try {
    const initial = await project.open("/render-siblings"); revision = "1"; block = true;
    const response = project.refresh({ ...initial, sequence: 1, queries: [{ name: "value", input: {} }] });
    const result = await Promise.race([response, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(result).not.toBeNull();
    expect(result?.queries[0]).toMatchObject({ data: "1", stale: false });
  } finally { release(); await project.close(); }
});

for (let repeat = 1; repeat <= 2; repeat++) test(`superseded refresh responses cannot replace a later request, repeat ${repeat}`, async () => {
  let block = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const project = new ReactiveProject({
    revision: async () => { if (block) await gate; return { epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }; },
    validate: (_name, input) => input, query: async (_name, input) => input,
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/ordering"); block = true;
    const first = project.refresh({ ...initial, sequence: 1, queries: [{ name: "value", input: "old" }] });
    await Promise.resolve();
    const next = project.refresh({ ...initial, sequence: 2, queries: [{ name: "value", input: "new" }] });
    release();
    const results = await Promise.allSettled([first, next]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "RESPONSE_OBSOLETE" } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { sequence: 2, queries: [{ data: "new", stale: false }] } });
  } finally { release(); await project.close(); }
});

test("closing a project denies work suspended at its admission probe", async () => {
  let block = false, release!: () => void, releaseRender!: () => void, renders = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const renderGate = new Promise<void>(resolve => { releaseRender = resolve; });
  const project = new ReactiveProject({
    revision: async () => { if (block) await gate; return { epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }; },
    validate: (_name, input) => input, query: async () => "data",
    render: async () => { if (++renders > 1) await renderGate; return { html: "data", islands: [], regions: [] }; },
  });
  try {
    const initial = await project.open("/closing"); block = true;
    const refresh = project.refresh({ ...initial, sequence: 1, force: true, queries: [] });
    await Promise.resolve(); await Promise.resolve();
    const closing = project.close(); release();
    await closing;
    await refresh.catch(() => {});
    expect(renders).toBe(1);
    await expect(project.open("/after-close")).rejects.toThrow("APPLICATION_CLOSED");
  } finally { release(); releaseRender(); await project.close(); }
});

test("a pending server dependency does not stall a healthy sibling region", async () => {
  let revision = "0", release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision }), validate: (_name, input) => input,
    query: async name => { if (name === "slow" && revision === "1") await slow; return name + revision; },
    render: async (_path, read) => {
      const regions = [], pieces = [];
      for (const name of ["slow", "healthy"]) {
        try { pieces.push(String(await read(name, {}))); regions.push({ id: name, dependencies: [{ name, input: {} }] }); }
        catch (error) { regions.push({ id: name, dependencies: [{ name, input: {} }], error: error instanceof Error ? error.message : "INTERNAL_FAILURE" }); }
      }
      return { html: pieces.join(" "), islands: [], regions };
    },
  });
  try {
    const initial = await project.open("/server-siblings"); revision = "1";
    const result = await project.refresh({ ...initial, sequence: 1, queries: [] });
    expect(result.rendered.html).toContain("healthy1");
    expect(result.rendered.regions.find(region => region.id === "slow")?.error).toBe("QUERY_PENDING");
  } finally { release(); await project.close(); }
});

test("concurrent equal reads share execution while retaining separate logical subscriptions and public values", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }), validate: (_name, input) => input,
    query: async () => { calls++; await gate; return { name: "stored" }; },
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  try {
    const first = await project.open("/shared-read"), second = await project.open("/shared-read");
    await Promise.all([project.refresh({ ...first, sequence: 1, queries: [{ name: "value", input: { a: 1, b: 2 } }] }), project.refresh({ ...second, sequence: 1, queries: [{ name: "value", input: { b: 2, a: 1 } }] })]);
    expect(calls).toBe(1);
    release(); await Promise.resolve();
    const results = await Promise.all([project.refresh({ ...first, sequence: 2, queries: [{ name: "value", input: { a: 1, b: 2 } }] }), project.refresh({ ...second, sequence: 2, queries: [{ name: "value", input: { a: 1, b: 2 } }] })]);
    (results[0]!.queries[0]!.data as { name: string }).name = "draft";
    expect(results[1]!.queries[0]!.data).toEqual({ name: "stored" });
    expect(first.connection).not.toBe(second.connection);
  } finally { release(); await project.close(); }
});
