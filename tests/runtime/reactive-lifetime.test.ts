import { expect, test } from "bun:test";
import { ReactiveProject } from "../../src/runtime/reactive-project";

for (let repeat = 1; repeat <= 2; repeat++) test(`abandoned browser connections expire within 30 seconds, repeat ${repeat}`, async () => {
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }),
    validate: (_name, input) => input, query: async () => "data",
    render: async () => ({ html: "<main></main>", islands: [], regions: [] }),
  });
  try {
    const initial = await project.open("/abandoned");
    await Bun.sleep(29_100);
    await expect(project.refresh({ ...initial, sequence: 1, queries: [] })).rejects.toThrow("CONNECTION_EXPIRED");
  } finally { await project.close(); }
}, 31_000);
