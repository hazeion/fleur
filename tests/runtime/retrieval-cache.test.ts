import { expect, test } from "bun:test";
import { ReactiveProject, type RefreshResponse } from "../../src/runtime/reactive-project";
import { RetrievalError } from "../../src/runtime/retrieval/destinations";

const epoch = "00000000-0000-4000-8000-000000000000";
/** A fake backend whose page reads one database query and one retrieval keyed by the path. */
function fixture() {
  const state = { revision: "0", calls: [] as unknown[], next: [] as (() => Promise<unknown>)[] };
  const project = new ReactiveProject({
    revision: async () => ({ epoch, revision: state.revision }),
    validate: (_name, input) => input,
    query: async () => state.revision,
    validateRetrieval: (name, input) => {
      if (name !== "weather") throw new Error("REQUEST_DENIED");
      if (!input || typeof input !== "object" || typeof (input as { city?: unknown }).city !== "string") throw new Error("INPUT_INVALID");
      return input;
    },
    retrieve: async (_name, input) => { state.calls.push(input); const step = state.next.shift(); return step ? step() : { temperature: state.calls.length }; },
    render: async (path, read, retrieve) => {
      const revision = await read("revision", {});
      let weather: string;
      try { weather = `temperature ${(await retrieve("weather", { city: path.slice(1) }) as { temperature: number }).temperature}`; }
      catch (error) {
        if (error instanceof RetrievalError) weather = `unavailable ${error.code}`;
        else throw error;
      }
      return { html: `<main>revision ${String(revision)}; ${weather}</main>`, islands: [], regions: [] };
    },
  });
  return { state, project };
}
async function settle(project: ReactiveProject, view: RefreshResponse, sequence: { value: number }, expected: string, extra: object = {}): Promise<RefreshResponse> {
  let result = view;
  for (let attempt = 0; attempt < 50 && !result.rendered.html.includes(expected); attempt++) {
    result = await project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: ++sequence.value, queries: [], ...extra });
    if (!result.rendered.html.includes(expected)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(result.rendered.html).toContain(expected);
  return result;
}

test("first load retrieves; database rerenders reuse the view's cached result; explicit refresh retrieves again", async () => {
  const { state, project } = fixture();
  try {
    const sequence = { value: 0 };
    const view = await project.open("/paris");
    expect(view.rendered.html).toBe("<main>revision 0; temperature 1</main>");
    expect(state.calls).toEqual([{ city: "paris" }]);
    state.revision = "1";
    await settle(project, view, sequence, "revision 1; temperature 1");
    state.revision = "2";
    await settle(project, view, sequence, "revision 2; temperature 1");
    expect(state.calls).toHaveLength(1);
    const refreshed = await project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: ++sequence.value, queries: [], retrievals: [{ name: "weather", input: { city: "paris" } }] });
    expect(refreshed.retrievals).toEqual([{ name: "weather", input: { city: "paris" }, status: "current" }]);
    expect(refreshed.rendered.html).toBe("<main>revision 2; temperature 2</main>");
    expect(state.calls).toHaveLength(2);
    // A new view has its own initial load; nothing is shared across views.
    const other = await project.open("/paris");
    expect(other.rendered.html).toBe("<main>revision 2; temperature 3</main>");
    // New inputs retrieve on first use.
    const london = await project.open("/london");
    expect(london.rendered.html).toBe("<main>revision 2; temperature 4</main>");
    expect(state.calls).toEqual([{ city: "paris" }, { city: "paris" }, { city: "paris" }, { city: "london" }]);
  } finally { await project.close(); }
});

test("a cached failure stays an explicit failure across database rerenders until explicitly refreshed", async () => {
  const { state, project } = fixture();
  try {
    const sequence = { value: 0 };
    state.next.push(async () => { throw new RetrievalError("RETRIEVAL_TIMEOUT"); });
    const view = await project.open("/oslo");
    expect(view.rendered.html).toBe("<main>revision 0; unavailable RETRIEVAL_TIMEOUT</main>");
    state.revision = "1";
    await settle(project, view, sequence, "revision 1; unavailable RETRIEVAL_TIMEOUT");
    expect(state.calls).toHaveLength(1);
    state.next.push(async () => { throw new RetrievalError("RETRIEVAL_HTTP_FAILURE", 503); });
    const failed = await project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: ++sequence.value, queries: [], retrievals: [{ name: "weather", input: { city: "oslo" } }] });
    expect(failed.retrievals).toEqual([{ name: "weather", input: { city: "oslo" }, status: "error", error: "RETRIEVAL_HTTP_FAILURE" }]);
    expect(failed.rendered.html).toBe("<main>revision 1; unavailable RETRIEVAL_HTTP_FAILURE</main>");
    const recovered = await project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: ++sequence.value, queries: [], retrievals: [{ name: "weather", input: { city: "oslo" } }] });
    expect(recovered.retrievals?.[0]?.status).toBe("current");
    expect(recovered.rendered.html).toBe("<main>revision 1; temperature 3</main>");
  } finally { await project.close(); }
});

test("explicit refresh validates the retrieval name and input before any external work", async () => {
  const { state, project } = fixture();
  try {
    const view = await project.open("/rome");
    await expect(project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: 1, queries: [], retrievals: [{ name: "unknown", input: {} }] })).rejects.toThrow("REQUEST_DENIED");
    await expect(project.refresh({ connection: view.connection, page: view.page, generation: 0, sequence: 2, queries: [], retrievals: [{ name: "weather", input: { city: 1 } }] })).rejects.toThrow("INPUT_INVALID");
    expect(state.calls).toHaveLength(1);
  } finally { await project.close(); }
});
