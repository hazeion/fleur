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

for (let repeat = 1; repeat <= 2; repeat++) test(`closing reactive admission is bounded even when backend work never settles, repeat ${repeat}`, async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const project = new ReactiveProject({
    revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }),
    validate: (_name, input) => input, query: async () => "data",
    render: async () => { entered(); await held; return { html: "<main></main>", islands: [], regions: [] }; },
  });
  const opening = project.open("/held").catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    // The lifecycle passes its remaining drain budget to every owner.
    const outcome = await Promise.race([project.close(100).then(() => "closed", error => error instanceof Error ? error.message : "unknown"), new Promise<string>(resolve => { timer = setTimeout(() => resolve("unbounded"), 1000); })]);
    expect(outcome).toBe("REACTIVE_DRAIN_UNCONFIRMED");
    await expect(project.open("/new")).rejects.toThrow("APPLICATION_CLOSED");
  } finally { clearTimeout(timer); release(); await opening; await project.close(); }
}, 5000);
