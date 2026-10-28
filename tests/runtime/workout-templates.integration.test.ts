import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issue #31 and the workout acceptance fixture in docs/planning/V1-SPEC.md.
// Every operation runs through the restricted application path against an owned disposable database.
interface Exercise { id: string; name: string; version: number }
interface Entry { exerciseId: string; exerciseName: string; targetSets: number; targetRepetitions: number }
interface Template { id: string; name: string; version: number; entries: Entry[] }
interface Listing { templates: Template[]; complete: boolean }

let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
let fixture: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
let app: ReadApplication;
const exercises: Record<string, Exercise> = {};
const list = async () => await app.query("template.list", {}) as Listing;
const stored = async (id: string) => (await list()).templates.find(item => item.id === id);
const entry = (name: string, targetSets: number, targetRepetitions: number) => ({ exerciseId: exercises[name]!.id, targetSets, targetRepetitions });
const shown = (name: string, targetSets: number, targetRepetitions: number): Entry => ({ exerciseId: exercises[name]!.id, exerciseName: name, targetSets, targetRepetitions });

beforeAll(async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/workouts", import.meta.url)));
  images = await prepareNativeImages(await compileWorker(project));
  fixture = await ownedPostgres();
  await fixture.reviewApplication(images, true);
  app = await ReadApplication.open(images, fixture.url);
  for (const name of ["Squat", "Bench press", "Row", "Deadlift"]) exercises[name] = await app.mutate("exercise.create", { name }) as Exercise;
  // Competing saves need two retained slots. Create the second before any race so cold
  // slot creation cannot consume a contender's five-second deadline.
  await Promise.allSettled([list(), list()]);
  const deadline = Date.now() + 60_000;
  while (app.diagnostics().filter(slot => slot.state === "idle").length < 2) {
    if (Date.now() > deadline) throw new Error("Second retained slot did not become ready");
    await Bun.sleep(100);
  }
}, 300_000);
afterAll(async () => {
  const failures: unknown[] = [];
  for (const cleanup of [() => app?.close(), () => fixture?.cleanup(), () => images?.dispose()]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  expect(failures, "Workout template fixture cleanup requires inspection").toEqual([]);
}, 120_000);

test("creates trimmed templates with repeated ordered exercises and reads them through one joined ordered listing", async () => {
  const created = await app.mutate("template.create", { name: "  Push day  ", entries: [entry("Bench press", 3, 5), entry("Squat", 2, 10), entry("Bench press", 4, 6)] }) as Template;
  expect(created).toEqual({ id: expect.any(String), name: "Push day", version: 1, entries: [shown("Bench press", 3, 5), shown("Squat", 2, 10), shown("Bench press", 4, 6)] });
  const duplicate = await app.mutate("template.create", { name: "Push day", entries: [entry("Row", 1, 1)] }) as Template;
  expect(duplicate.id).not.toBe(created.id);
  const astral = "😀".repeat(100);
  const widest = await app.mutate("template.create", { name: astral, entries: [entry("Deadlift", Number.MAX_SAFE_INTEGER, 1)] }) as Template;
  expect(widest).toMatchObject({ name: astral, entries: [shown("Deadlift", Number.MAX_SAFE_INTEGER, 1)] });
  const listing = await list();
  expect(listing.complete).toBe(true);
  const pushDays = listing.templates.filter(item => item.name === "Push day");
  expect(pushDays.map(item => item.id)).toEqual([created.id, duplicate.id].sort());
  expect(listing.templates.find(item => item.id === created.id)).toEqual(created);
  const names = listing.templates.map(item => item.name);
  expect(names).toEqual([...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}, 60_000);

test("rejects malformed template input before any write", async () => {
  const before = await list();
  const valid = { name: "Rejected", entries: [entry("Squat", 3, 5)] };
  const malformed: unknown[] = [
    { ...valid, name: "   " },
    { ...valid, name: "😀".repeat(101) },
    { ...valid, entries: [] },
    { name: "Rejected" },
    { ...valid, extra: true },
    { ...valid, entries: [{ ...entry("Squat", 3, 5), note: "undeclared" }] },
    { ...valid, entries: [{ exerciseId: exercises.Squat!.id, targetSets: 3 }] },
    { ...valid, entries: [entry("Squat", 0, 5)] },
    { ...valid, entries: [entry("Squat", 3, -1)] },
    { ...valid, entries: [entry("Squat", 1.5, 5)] },
    { ...valid, entries: [{ ...entry("Squat", 3, 5), targetSets: "3" }] },
    { ...valid, entries: [entry("Squat", Number.MAX_SAFE_INTEGER + 1, 5)] },
    { ...valid, entries: [{ ...entry("Squat", 3, 5), exerciseId: "not-a-uuid" }] },
    { ...valid, entries: Array.from({ length: 101 }, () => entry("Squat", 1, 1)) },
  ];
  for (const input of malformed) await expect(app.mutate("template.create", input), JSON.stringify(input).slice(0, 120)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(await list()).toEqual(before);
}, 60_000);

test("header, child and ordering edits each advance one aggregate version", async () => {
  const created = await app.mutate("template.create", { name: "Legs", entries: [entry("Squat", 5, 5), entry("Deadlift", 1, 5)] }) as Template;
  const renamed = await app.mutate("template.update", { id: created.id, expectedVersion: 1, name: " Heavy legs ", entries: [entry("Squat", 5, 5), entry("Deadlift", 1, 5)] }) as Template;
  expect(renamed).toEqual({ ...created, name: "Heavy legs", version: 2 });
  const retargeted = await app.mutate("template.update", { id: created.id, expectedVersion: 2, name: "Heavy legs", entries: [entry("Squat", 3, 8), entry("Deadlift", 1, 5), entry("Squat", 2, 12)] }) as Template;
  expect(retargeted).toEqual({ ...renamed, version: 3, entries: [shown("Squat", 3, 8), shown("Deadlift", 1, 5), shown("Squat", 2, 12)] });
  const reordered = await app.mutate("template.update", { id: created.id, expectedVersion: 3, name: "Heavy legs", entries: [entry("Squat", 2, 12), entry("Squat", 3, 8), entry("Deadlift", 1, 5)] }) as Template;
  expect(reordered).toEqual({ ...retargeted, version: 4, entries: [shown("Squat", 2, 12), shown("Squat", 3, 8), shown("Deadlift", 1, 5)] });
  expect(await stored(created.id)).toEqual(reordered);
  await expect(app.mutate("template.update", { id: created.id, expectedVersion: 3, name: "Stale", entries: [entry("Row", 1, 1)] })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(app.mutate("template.update", { id: randomUUID(), expectedVersion: 1, name: "Absent", entries: [entry("Row", 1, 1)] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(app.mutate("template.update", { id: created.id, expectedVersion: 4, name: "  ", entries: [entry("Row", 1, 1)] })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(await stored(created.id)).toEqual(reordered);
}, 60_000);

test("child and output failures roll back the header and every child write", async () => {
  const before = await list();
  await expect(app.mutate("template.create", { name: "Orphan", entries: [entry("Row", 3, 10), { exerciseId: randomUUID(), targetSets: 3, targetRepetitions: 10 }] })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await list()).toEqual(before);
  const created = await app.mutate("template.create", { name: "Pull", entries: [entry("Row", 4, 8), entry("Deadlift", 1, 3)] }) as Template;
  await expect(app.mutate("template.update", { id: created.id, expectedVersion: 1, name: "Pull changed", entries: [entry("Bench press", 2, 2), { exerciseId: randomUUID(), targetSets: 1, targetRepetitions: 1 }] })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await stored(created.id)).toEqual(created);
  await expect(app.mutate("template.rejectOutput", { id: created.id, expectedVersion: 1, name: "Pull output", entries: [entry("Squat", 9, 9)] })).rejects.toThrow("INTERNAL_FAILURE");
  expect(await stored(created.id)).toEqual(created);
}, 60_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`competing saves at one expected version have one winner and never mix children, repeat ${repeat}`, async () => {
  const created = await app.mutate("template.create", { name: `Contested ${repeat}`, entries: [entry("Squat", 1, 1), entry("Row", 1, 1)] }) as Template;
  const left = { id: created.id, expectedVersion: 1, name: `Left ${repeat}`, entries: [entry("Bench press", 3, 5), entry("Bench press", 3, 5), entry("Bench press", 3, 5)] };
  const right = { id: created.id, expectedVersion: 1, name: `Right ${repeat}`, entries: [entry("Deadlift", 1, 1)] };
  const results = await Promise.allSettled([app.mutate("template.update", left), app.mutate("template.update", right)]);
  const winners = results.filter(result => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = (winners[0] as PromiseFulfilledResult<unknown>).value as Template;
  expect(winner.version).toBe(2);
  expect([`Left ${repeat}`, `Right ${repeat}`]).toContain(winner.name);
  expect(await stored(created.id)).toEqual(winner);
}, 60_000);

test("current template entries restrict exercise deletion until the template stops referencing it", async () => {
  const lunge = await app.mutate("exercise.create", { name: "Lunge" }) as Exercise;
  exercises.Lunge = lunge;
  const created = await app.mutate("template.create", { name: "Lunges", entries: [entry("Lunge", 3, 12), entry("Squat", 3, 5)] }) as Template;
  await expect(app.mutate("exercise.delete", { id: lunge.id, expectedVersion: lunge.version })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect((await app.query("exercise.list", {}) as Exercise[]).some(item => item.id === lunge.id)).toBe(true);
  expect(await stored(created.id)).toEqual(created);
  await app.mutate("template.update", { id: created.id, expectedVersion: 1, name: "Squats", entries: [entry("Squat", 3, 5)] });
  expect(await app.mutate("exercise.delete", { id: lunge.id, expectedVersion: lunge.version })).toEqual({ deleted: true });
}, 60_000);
