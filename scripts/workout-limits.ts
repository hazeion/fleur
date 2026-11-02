import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const referenceId = "00000000-0000-4000-8000-000000000001";
interface Query { name: string; input: Record<string, string | number> }
interface Answer { name: string; input: unknown; status: string; error?: string; data?: unknown }
/** Exercise the real production transport and broker, not a synthetic subscription backend. */
export async function workoutLimits(url: string, signal: AbortSignal): Promise<string[]> {
  const retained = new Map<object, Query[]>();
  let lastHeartbeat = performance.now();
  const handles: { connection: string; page: string; generation: number; sequence: number }[] = [];
  async function request(body: unknown, disposing = false) {
    const response = await fetch(new URL("/__fleur/view", url), { method: "POST", headers: { origin: new URL(url).origin, "x-fleur-request": "view", "content-type": "application/json" }, body: JSON.stringify(body), signal: disposing ? AbortSignal.timeout(10000) : AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    const text = await response.text();
    assert.equal(response.ok, true, `Production view request failed (${response.status}): ${text.slice(0, 2048)}`); return JSON.parse(text);
  }
  async function open() {
    const opened = await request({ action: "open", path: "/reference/0" });
    const handle = { connection: opened.connection, page: opened.page, generation: opened.generation, sequence: opened.sequence };
    handles.push(handle); retained.set(handle, []); return handle;
  }
  async function refresh(handle: (typeof handles)[number], queries: Query[], force = false): Promise<Answer[]> {
    retained.set(handle, queries);
    const result = await request({ action: "refresh", ...handle, sequence: ++handle.sequence, queries, ...(force ? { force: true } : {}) });
    return result.queries;
  }
  async function settled(handle: (typeof handles)[number], queries: Query[]): Promise<Answer[]> {
    const deadline = performance.now() + 7000;
    for (;;) {
      signal.throwIfAborted();
      const answers = await refresh(handle, queries);
      if (answers.every(answer => answer.status === "current" || answer.status === "error")) return answers;
      if (performance.now() >= deadline) throw new Error("Bounded production query observation expired");
      await Bun.sleep(20);
    }
  }
  const selection = (count: number) => Array.from({ length: count }, (_, index) => ({ name: "reference.list", input: { collection: "exercise", after: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` } }));
  async function dispose(handle: (typeof handles)[number]) { await request({ action: "dispose", connection: handle.connection, page: handle.page }, true); handles.splice(handles.indexOf(handle), 1); retained.delete(handle); }
  let originalError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    // This proves retained subscription capacity. Register incrementally so the
    // cap check does not create and abandon a separate cold execution burst.
    // Sustained/burst latency is measured independently by the reference runs.
    const heartbeat = async () => {
      if (performance.now() - lastHeartbeat < 5000) return;
      for (const handle of handles) {
        const queries = retained.get(handle)!;
        const answers = await refresh(handle, queries);
        assert.equal(answers.filter(answer => answer.status === "current").length, queries.length);
      }
      lastHeartbeat = performance.now();
    };
    const fill = async (handle: (typeof handles)[number]) => {
      for (let count = 1; count <= 20; count++) {
        const answers = await settled(handle, selection(count));
        assert.equal(answers.filter(answer => answer.status === "current").length, count);
        await heartbeat();
      }
    };
    const bounded = await open();
    await fill(bounded);
    const tooMany = await settled(bounded, selection(21));
    assert.equal(tooMany.filter(answer => answer.status === "current").length, 20);
    assert.equal(tooMany.filter(answer => answer.error === "QUERY_LIMIT").length, 1);
    await dispose(bounded);
    const capacity = [];
    for (let index = 0; index < 6; index++) capacity.push(await open());
    for (const handle of capacity.slice(0, 5)) await fill(handle);
    const extra = capacity[5]!;
    assert.equal((await refresh(extra, selection(1)))[0]!.error, "QUERY_LIMIT");
    await dispose(handles[0]!);
    assert.equal((await settled(extra, selection(1)))[0]!.status, "current");
    for (const handle of handles.slice()) await dispose(handle);
    const encoded = await open();
    const exactly = await settled(encoded, [{ name: "reference.large", input: { characters: 524287 } }]);
    assert.equal(exactly[0]!.status, "current");
    assert.equal(Buffer.byteLength(JSON.stringify(exactly[0]!.data), "utf8"), 1048576);
    const oversized = await settled(encoded, [{ name: "reference.large", input: { characters: 524288 } }]);
    assert.equal(oversized[0]!.error, "RESULT_TOO_LARGE");
    await dispose(encoded);
    const healthy = await open(), slow = await open();
    const healthyQuery: Query[] = [{ name: "reference.exercise", input: { id: referenceId } }];
    assert.equal((await settled(healthy, healthyQuery))[0]!.status, "current");
    const started = performance.now();
    // Observe rejection immediately: an earlier healthy-query failure still
    // disposes this handle, which can interrupt its outstanding HTTP request.
    const pending = settled(slow, [{ name: "reference.slow", input: { milliseconds: 10000 } }]).then(
      answers => ({ ok: true, answers }) as const,
      error => ({ ok: false, error }) as const,
    );
    const fast = await refresh(healthy, healthyQuery, true);
    const served = fast[0]?.status === "current" ? fast : await settled(healthy, healthyQuery);
    assert.equal(served[0]!.status, "current");
    assert.ok(performance.now() - started < 1000, "A slow query starved a healthy subscription");
    const cancelled = await pending;
    if (!cancelled.ok) throw cancelled.error;
    assert.equal(cancelled.answers[0]!.error, "QUERY_TIMEOUT");
    assert.ok(performance.now() - started < 6000, "The query deadline did not include waiting and execution");
  } catch (error) { originalError = error; }
  finally { for (const handle of handles.slice()) try { await dispose(handle); } catch (error) { cleanupErrors.push(error); } }
  if (originalError || cleanupErrors.length) throw new AggregateError([originalError, ...cleanupErrors].filter(Boolean), "Production limit proof or disposal failed");
  return ["20 active queries per connection and 100 per project; disposal frees capacity", "exact 1 MiB encoded UTF-8 result accepted; two extra encoded bytes rejected", "slow-query cancellation and independent healthy-query service"];
}
