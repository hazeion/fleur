import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issue #32 and the workout acceptance fixture in docs/planning/V1-SPEC.md.
// Sessions are dated, immutable snapshots: exercise names, order, sets, repetitions and exact
// kg/lb weights are copied into session rows, so later catalog or template changes cannot
// rewrite them. Every operation runs through the restricted application path against an owned
// disposable database.
interface Weight { value: string; unit: "kg" | "lb" }
interface WorkoutSet { repetitions: number; weight?: Weight }
interface SessionExercise { name: string; sets: WorkoutSet[] }
interface Session { id: string; date: string; templateName?: string; version: number; exercises: SessionExercise[] }
interface Listing { sessions: Session[]; cursor?: string }
interface Exercise { id: string; name: string; version: number }
interface Template { id: string; name: string; version: number }
const pageSize = 20;

let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
let fixture: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
let app: ReadApplication;
async function pages(): Promise<Listing[]> {
  const result: Listing[] = [];
  let cursor: string | undefined;
  do {
    const page = await app.query("session.list", cursor === undefined ? {} : { cursor }) as Listing;
    result.push(page);
    cursor = page.cursor;
    if (result.length > 100) throw new Error("History did not end within 100 pages");
  } while (cursor !== undefined);
  return result;
}
const list = async () => (await pages()).flatMap(page => page.sessions);
const stored = async (id: string) => (await list()).find(item => item.id === id);
const childRows = async () => {
  const [row] = await fixture!.sql.unsafe("SELECT (SELECT count(*) FROM workout_session_exercises)::int AS exercises, (SELECT count(*) FROM workout_session_sets)::int AS sets");
  return row as { exercises: number; sets: number };
};
const set = (repetitions: number, value?: string, unit?: "kg" | "lb"): WorkoutSet => value === undefined ? { repetitions } : { repetitions, weight: { value, unit: unit! } };
const valid = () => ({ date: "2026-10-20", exercises: [{ name: "Squat", sets: [set(5, "100", "kg")] }] });

beforeAll(async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/workouts", import.meta.url)));
  images = await prepareNativeImages(await compileWorker(project));
  fixture = await ownedPostgres();
  await fixture.reviewApplication(images, true);
  // Calendar dates carry no time zone: a session's LocalDate must not shift with the database
  // session's zone. Pick one 14 hours ahead of UTC before any connection opens.
  await fixture.sql.unsafe(`ALTER DATABASE "${String((await fixture.sql.unsafe("SELECT current_database() AS name"))[0].name).replaceAll('"', '""')}" SET timezone TO 'Pacific/Kiritimati'`);
  app = await ReadApplication.open(images, fixture.url);
  // Competing saves need two retained slots. Create the second before any race so cold
  // slot creation cannot consume a contender's five-second deadline.
  await Promise.allSettled([app.query("session.list", {}), app.query("session.list", {})]);
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
  expect(failures, "Workout session fixture cleanup requires inspection").toEqual([]);
}, 120_000);

test("records ordered exercise and set snapshots with exact weights, normalizing zeroes without numeric conversion", async () => {
  const created = await app.mutate("session.create", {
    date: "2026-10-28", templateName: "  Push day  ",
    exercises: [
      { name: "  Bench press ", sets: [set(5, "080.50", "kg"), set(5, "0.00", "lb"), set(8)] },
      { name: "Squat", sets: [set(3, "100", "lb"), set(3, "99999.99", "kg"), set(1, "007", "kg")] },
      { name: "Bench press", sets: [set(12, "0.1", "kg"), set(12, "0.30", "lb")] },
    ],
  }) as Session;
  // Trailing and leading zeroes are dropped textually; zero stays explicit data; units never convert.
  expect(created).toEqual({
    id: expect.any(String), date: "2026-10-28", templateName: "Push day", version: 1,
    exercises: [
      { name: "Bench press", sets: [set(5, "80.5", "kg"), set(5, "0", "lb"), set(8)] },
      { name: "Squat", sets: [set(3, "100", "lb"), set(3, "99999.99", "kg"), set(1, "7", "kg")] },
      { name: "Bench press", sets: [set(12, "0.1", "kg"), set(12, "0.3", "lb")] },
    ],
  });
  expect(await stored(created.id)).toEqual(created);
  // Sessions may omit a source template and record exercises outside the catalog.
  const freeform = await app.mutate("session.create", { date: "2026-10-27", exercises: [{ name: "Farmer carry", sets: [set(1)] }] }) as Session;
  expect(freeform).toEqual({ id: expect.any(String), date: "2026-10-27", version: 1, exercises: [{ name: "Farmer carry", sets: [set(1)] }] });
  expect(Object.hasOwn(freeform, "templateName")).toBe(false);
  expect(await stored(freeform.id)).toEqual(freeform);
}, 60_000);

test("LocalDate values round-trip unchanged under a database time zone far from UTC", async () => {
  const [setting] = await fixture!.sql.unsafe("SELECT array_to_string(setconfig, ',') AS config FROM pg_db_role_setting JOIN pg_database ON pg_database.oid=setdatabase WHERE datname=current_database() AND setrole=0");
  expect(setting?.config).toBe("TimeZone=Pacific/Kiritimati");
  for (const date of ["2024-02-29", "2026-12-31", "2027-01-01", "0001-01-01", "9999-12-31"]) {
    const created = await app.mutate("session.create", { date, exercises: [{ name: "Row", sets: [set(1)] }] }) as Session;
    expect(created.date).toBe(date);
    expect((await stored(created.id))?.date).toBe(date);
  }
}, 60_000);

test("history lists newest dates first and reads exercises and sets in position order regardless of insertion order or row identity", async () => {
  const id = randomUUID();
  await fixture!.sql.unsafe("INSERT INTO workout_sessions(id,date) VALUES($1,'9999-12-30')", [id]);
  // Exercises inserted 1, 2, 0 and sets inserted 2, 0, 1, each with identities in the opposite order.
  const exerciseRows = [["bbbbbbbb-0000-4000-8000-000000000001", 1, "Row"], ["aaaaaaaa-0000-4000-8000-000000000001", 2, "Squat"], ["cccccccc-0000-4000-8000-000000000001", 0, "Deadlift"]] as const;
  for (const [exerciseId, position, name] of exerciseRows) {
    await fixture!.sql.unsafe('INSERT INTO workout_session_exercises(id,"sessionId",position,name) VALUES($1,$2,$3,$4)', [exerciseId, id, position, name]);
    for (const [setId, setPosition] of [["aaaaaaaa", 2], ["cccccccc", 0], ["bbbbbbbb", 1]] as const)
      await fixture!.sql.unsafe('INSERT INTO workout_session_sets(id,"sessionExerciseId",position,repetitions) VALUES($1,$2,$3,$4)', [`${setId}-${String(position + 1).padStart(4, "0")}-4000-8000-000000000002`, exerciseId, setPosition, setPosition + 1]);
  }
  const all = await list();
  expect(all.find(item => item.id === id)?.exercises).toEqual(["Deadlift", "Row", "Squat"].map(name => ({ name, sets: [set(1), set(2), set(3)] })));
  const dates = all.map(item => item.date);
  expect(dates).toEqual([...dates].sort().reverse());
}, 60_000);

test("history pages through sessions whose sets exceed one bounded read, never splitting a session", async () => {
  const ids: string[] = [];
  for (let index = 1; index <= 25; index++) {
    const id = randomUUID();
    ids.push(id);
    await fixture!.sql.unsafe("INSERT INTO workout_sessions(id,date) VALUES($1,$2)", [id, `5000-01-${String(index).padStart(2, "0")}`]);
    await fixture!.sql.unsafe('INSERT INTO workout_session_exercises(id,"sessionId",position,name) VALUES($1,$1,0,$2)', [id, `Bulk ${index}`]);
    await fixture!.sql.unsafe('INSERT INTO workout_session_sets("sessionExerciseId",position,repetitions,weight,unit) SELECT $1,position,position+1,position+0.25,\'kg\' FROM generate_series(0,49) AS position', [id]);
  }
  const listed = await pages();
  expect(listed.length).toBeGreaterThanOrEqual(2);
  for (const page of listed.slice(0, -1)) expect(page).toMatchObject({ sessions: { length: pageSize }, cursor: expect.any(String) });
  expect(listed.at(-1)!.cursor).toBeUndefined();
  const all = listed.flatMap(page => page.sessions);
  expect(new Set(all.map(item => item.id)).size).toBe(all.length);
  const bulk = all.filter(item => ids.includes(item.id));
  expect(bulk.map(item => item.date)).toEqual(Array.from({ length: 25 }, (_, index) => `5000-01-${String(25 - index).padStart(2, "0")}`));
  for (const item of bulk) expect(item.exercises).toEqual([{ name: `Bulk ${Number(item.date.slice(-2))}`, sets: Array.from({ length: 50 }, (_, position) => set(position + 1, `${position}.25`, "kg")) }]);
}, 60_000);

test("rejects malformed dates, weights, counts and undeclared fields on the server before any write", async () => {
  const before = await list(), rows = await childRows();
  const base = valid();
  const withSet = (value: unknown) => ({ ...base, exercises: [{ name: "Squat", sets: [value] }] });
  const withWeight = (weight: unknown) => withSet({ repetitions: 5, weight });
  const malformed: unknown[] = [
    // Dates: calendar-valid YYYY-MM-DD only; no timestamps, numbers or Date objects.
    { ...base, date: "2023-02-29" }, { ...base, date: "2026-13-01" }, { ...base, date: "2026-1-5" }, { ...base, date: "20261028" },
    { ...base, date: "2026-10-28T00:00:00Z" }, { ...base, date: "0000-01-01" }, { ...base, date: 20261028 }, { ...base, date: new Date("2026-10-28") },
    { exercises: base.exercises }, { ...base, date: "" },
    // Weights: exact nonnegative decimal strings with at most two places and a kg/lb unit.
    withWeight({ value: String(0.1 + 0.2), unit: "kg" }), withWeight({ value: 0.3, unit: "kg" }), withWeight({ value: "1.005", unit: "kg" }),
    withWeight({ value: "-1", unit: "kg" }), withWeight({ value: "-0", unit: "lb" }), withWeight({ value: "1e2", unit: "kg" }),
    withWeight({ value: "Infinity", unit: "kg" }), withWeight({ value: "NaN", unit: "kg" }), withWeight({ value: ".5", unit: "kg" }),
    withWeight({ value: "5.", unit: "kg" }), withWeight({ value: " 5", unit: "kg" }), withWeight({ value: "1,5", unit: "kg" }), withWeight({ value: "+5", unit: "kg" }),
    withWeight({ value: "100000", unit: "kg" }), withWeight({ value: "5" }), withWeight({ unit: "kg" }), withWeight({ value: "5", unit: "KG" }),
    withWeight({ value: "5", unit: "g" }), withWeight(null), withWeight("5"), withWeight({ value: "5", unit: "kg", extra: true }),
    withSet({ repetitions: 5, weight: undefined }), withSet({ repetitions: 5, unit: "kg" }),
    // Repetitions: positive safe integers.
    withSet({ repetitions: 0 }), withSet({ repetitions: -1 }), withSet({ repetitions: 1.5 }), withSet({ repetitions: "5" }),
    withSet({ repetitions: Number.MAX_SAFE_INTEGER + 1 }), withSet({}), withSet({ repetitions: 5, note: "undeclared" }),
    // Exercises and counts: 1–50 exercises, 1–50 sets each and at most 50 sets per session.
    { ...base, exercises: [] }, { ...base, exercises: [{ name: "Squat", sets: [] }] }, { ...base, exercises: [{ name: "   ", sets: [set(1)] }] },
    { ...base, exercises: [{ name: "😀".repeat(101), sets: [set(1)] }] }, { ...base, exercises: [{ sets: [set(1)] }] },
    { ...base, exercises: [{ name: "Squat", sets: [set(1)], exerciseId: randomUUID() }] },
    { ...base, exercises: [{ name: "Squat", sets: Array.from({ length: 51 }, () => set(1)) }] },
    { ...base, exercises: Array.from({ length: 51 }, () => ({ name: "Squat", sets: [set(1)] })) },
    { ...base, exercises: [{ name: "Squat", sets: Array.from({ length: 26 }, () => set(1)) }, { name: "Row", sets: Array.from({ length: 25 }, () => set(1)) }] },
    // Source template snapshot: omitted or 1–100 code points after trimming.
    { ...base, templateName: "  " }, { ...base, templateName: "😀".repeat(101) }, { ...base, templateName: null }, { ...base, templateName: undefined },
    { ...base, templateId: randomUUID() }, { ...base, extra: true },
  ];
  for (const input of malformed) await expect(app.mutate("session.create", input), JSON.stringify(input)?.slice(0, 160)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  // The widest valid session is accepted: 50 sets split across exercises.
  const widest = await app.mutate("session.create", { ...base, exercises: [{ name: "Squat", sets: Array.from({ length: 25 }, () => set(1, "99999.99", "lb")) }, { name: "😀".repeat(100), sets: Array.from({ length: 25 }, () => set(Number.MAX_SAFE_INTEGER)) }] }) as Session;
  expect(widest.exercises.flatMap(item => item.sets)).toHaveLength(50);
  await app.mutate("session.delete", { id: widest.id, expectedVersion: 1 });
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
}, 60_000);

test("edits and deletes advance or check one aggregate version and replace every child atomically", async () => {
  const created = await app.mutate("session.create", { date: "2026-09-01", templateName: "Legs", exercises: [{ name: "Squat", sets: [set(5, "100", "kg"), set(5, "100", "kg")] }, { name: "Deadlift", sets: [set(1, "180", "kg")] }] }) as Session;
  const before = await childRows();
  const edited = await app.mutate("session.update", { id: created.id, expectedVersion: 1, date: "2026-09-02", exercises: [{ name: "Deadlift", sets: [set(1, "182.50", "kg")] }, { name: "Squat", sets: [set(5, "100", "kg"), set(4, "100", "kg"), set(3)] }] }) as Session;
  expect(edited).toEqual({ id: created.id, date: "2026-09-02", version: 2, exercises: [{ name: "Deadlift", sets: [set(1, "182.5", "kg")] }, { name: "Squat", sets: [set(5, "100", "kg"), set(4, "100", "kg"), set(3)] }] });
  expect(await stored(created.id)).toEqual(edited);
  expect(await childRows()).toEqual({ exercises: before.exercises, sets: before.sets + 1 });
  await expect(app.mutate("session.update", { ...valid(), id: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(app.mutate("session.update", { ...valid(), id: randomUUID(), expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Server-side rejections name the offending field by its path in the input.
  const rejected = (exercises: unknown[], extra: object = {}) => app.mutate("session.update", { ...valid(), id: created.id, expectedVersion: 2, exercises, ...extra });
  await expect(rejected([{ name: "Squat", sets: [set(1)] }, { name: " ", sets: [set(1)] }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { "exercises.1.name": expect.any(String) } });
  await expect(rejected([{ name: "Squat", sets: [set(1), set(1, "100000", "kg")] }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { "exercises.0.sets.1.weight": expect.any(String) } });
  await expect(rejected(valid().exercises, { templateName: " " })).rejects.toMatchObject({ code: "INPUT_INVALID", details: { templateName: expect.any(String) } });
  await expect(rejected([{ name: "Squat", sets: Array.from({ length: 26 }, () => set(1)) }, { name: "Row", sets: Array.from({ length: 25 }, () => set(1)) }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { exercises: expect.any(String) } });
  await expect(app.mutate("session.delete", { id: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await stored(created.id)).toEqual(edited);
  expect(await app.mutate("session.delete", { id: created.id, expectedVersion: 2 })).toEqual({ deleted: true });
  expect(await stored(created.id)).toBeUndefined();
  expect(await childRows()).toEqual({ exercises: before.exercises - 2, sets: before.sets - 3 });
  await expect(app.mutate("session.delete", { id: created.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(app.mutate("session.update", { ...valid(), id: created.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
}, 60_000);

test("child and output failures roll back the header and every child write", async () => {
  const created = await app.mutate("session.create", { date: "2026-08-01", exercises: [{ name: "Row", sets: [set(8, "60", "kg")] }] }) as Session;
  const before = await list(), rows = await childRows();
  const change = { id: created.id, expectedVersion: 1, date: "2026-08-02", templateName: "Changed", exercises: [{ name: "Squat", sets: [set(5, "1", "lb"), set(5, "2", "lb")] }, { name: "Bench press", sets: [set(1)] }] };
  await expect(app.mutate("session.rejectChild", change)).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
  await expect(app.mutate("session.rejectOutput", change)).rejects.toThrow("INTERNAL_FAILURE");
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
  expect(await stored(created.id)).toEqual(created);
}, 60_000);

/** Holds the session row so both operations are admitted and blocked before either can lock it. */
async function contest(id: string, left: () => Promise<unknown>, right: () => Promise<unknown>) {
  const lock = await fixture!.sql.reserve();
  try {
    await lock.unsafe("BEGIN");
    await lock.unsafe("SELECT id FROM workout_sessions WHERE id=$1 FOR UPDATE", [id]);
    const results = Promise.allSettled([left(), right()]);
    try {
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if (row?.waiting >= 2) break;
        if (Date.now() > deadline) throw new Error("Both operations did not reach the held session lock");
        await Bun.sleep(20);
      }
    } finally { await lock.unsafe("ROLLBACK"); }
    return await results;
  } finally { lock.release(); }
}
for (let repeat = 1; repeat <= 2; repeat++) test(`competing writers at one expected version have one winner and never mix children, repeat ${repeat}`, async () => {
  const created = await app.mutate("session.create", { date: "2026-07-01", exercises: [{ name: "Squat", sets: [set(1)] }, { name: "Row", sets: [set(1)] }] }) as Session;
  const left = { id: created.id, expectedVersion: 1, date: "2026-07-02", exercises: [{ name: "Bench press", sets: [set(3, "50", "kg"), set(3, "50", "kg"), set(3, "50", "kg")] }] };
  const right = { id: created.id, expectedVersion: 1, date: "2026-07-03", templateName: `Right ${repeat}`, exercises: [{ name: "Deadlift", sets: [set(1, "200", "lb")] }] };
  const saves = await contest(created.id, () => app.mutate("session.update", left), () => app.mutate("session.update", right));
  const winners = saves.filter(result => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  expect(saves.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = (winners[0] as PromiseFulfilledResult<unknown>).value as Session;
  expect(winner.version).toBe(2);
  expect(["2026-07-02", "2026-07-03"]).toContain(winner.date);
  expect(await stored(created.id)).toEqual(winner);

  // An edit and a delete at the same version: the loser reports the typed failure the winner caused.
  const races = await contest(created.id, () => app.mutate("session.update", { ...left, expectedVersion: 2 }), () => app.mutate("session.delete", { id: created.id, expectedVersion: 2 }));
  expect(races.filter(result => result.status === "fulfilled")).toHaveLength(1);
  if (races[0]!.status === "fulfilled") {
    expect(races[1]).toMatchObject({ status: "rejected", reason: { code: "VERSION_CONFLICT" } });
    expect(await stored(created.id)).toEqual(races[0].value as Session);
  } else {
    expect(races[0]).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    expect(await stored(created.id)).toBeUndefined();
  }
}, 60_000);

test("later exercise and template edits or deletion leave recorded sessions unchanged", async () => {
  const lunge = await app.mutate("exercise.create", { name: "Lunge" }) as Exercise;
  const squat = await app.mutate("exercise.create", { name: "Front squat" }) as Exercise;
  const template = await app.mutate("template.create", { name: "Lunges", entries: [{ exerciseId: lunge.id, targetSets: 2, targetRepetitions: 12 }, { exerciseId: squat.id, targetSets: 1, targetRepetitions: 5 }] }) as Template;
  const recorded = await app.mutate("session.create", { date: "2026-06-01", templateName: "Lunges", exercises: [{ name: "Lunge", sets: [set(12, "20", "kg"), set(10, "20", "kg")] }, { name: "Front squat", sets: [set(5, "60", "kg")] }] }) as Session;
  // Edit the template and the catalog name, then delete both: history keeps the recorded snapshot.
  await app.mutate("template.update", { id: template.id, expectedVersion: 1, name: "Renamed", entries: [{ exerciseId: squat.id, targetSets: 9, targetRepetitions: 9 }] });
  await fixture!.sql.unsafe("UPDATE exercises SET name='Walking lunge', version=version+1 WHERE id=$1", [lunge.id]);
  expect(await stored(recorded.id)).toEqual(recorded);
  await expect(app.mutate("template.delete", { id: template.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await app.mutate("template.delete", { id: template.id, expectedVersion: 2 })).toEqual({ deleted: true });
  await expect(app.mutate("template.delete", { id: template.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const [entries] = await fixture!.sql.unsafe('SELECT count(*)::int AS count FROM workout_template_entries WHERE "templateId"=$1', [template.id]);
  expect(entries?.count).toBe(0);
  // Sessions never restrict catalog deletion: once no template uses an exercise it can go.
  expect(await app.mutate("exercise.delete", { id: lunge.id, expectedVersion: 2 })).toEqual({ deleted: true });
  expect(await app.mutate("exercise.delete", { id: squat.id, expectedVersion: 1 })).toEqual({ deleted: true });
  expect(await stored(recorded.id)).toEqual(recorded);
  // A recorded session stays editable after its exercises and template are gone.
  const kept = await app.mutate("session.update", { id: recorded.id, expectedVersion: 1, date: "2026-06-01", templateName: "Lunges", exercises: [...recorded.exercises, { name: "Plank", sets: [set(1)] }] }) as Session;
  expect(kept).toEqual({ ...recorded, version: 2, exercises: [...recorded.exercises, { name: "Plank", sets: [set(1)] }] });
  // Structurally, session rows reference only their own aggregate, never the catalog or templates.
  const references = await fixture!.sql.unsafe("SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE 'workout_session%' ORDER BY 1");
  expect(references.map((row: { source: string; target: string }) => `${row.source}->${row.target}`)).toEqual(["workout_session_exercises->workout_sessions", "workout_session_sets->workout_session_exercises"]);
}, 60_000);

test("a delete committed between the history's header and set reads omits that session instead of failing the list", async () => {
  const doomed = await app.mutate("session.create", { date: "9999-12-31", exercises: [{ name: "Doomed", sets: [set(1)] }] }) as Session;
  const kept = await app.mutate("session.create", { date: "9999-12-31", exercises: [{ name: "Kept", sets: [set(2)] }] }) as Session;
  // REINDEX holds the set table's primary-key index exclusively. Planning any statement that
  // reads the table opens its indexes, so the list's set read waits; the schema drift check and
  // the header read do not open it and proceed. The delete commits before the set read starts.
  const lock = await fixture!.sql.reserve();
  let reading: Promise<unknown> | undefined;
  try {
    await lock.unsafe("BEGIN");
    const [index] = await lock.unsafe("SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid='workout_session_sets'::regclass AND indisprimary");
    await lock.unsafe(`REINDEX INDEX "${String(index?.name).replaceAll('"', '""')}"`);
    reading = app.query("session.list", {});
    reading.catch(() => {}); // Observed below; keep an early failure from going unhandled.
    let committed = false;
    try {
      // The query's own five-second budget includes this wait, so the delete must follow promptly.
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%workout_session_sets%'");
        if (row?.waiting >= 1) break;
        if (Date.now() > deadline) throw new Error(`The history's set read did not reach the held table lock: ${JSON.stringify(await fixture!.sql.unsafe("SELECT state, wait_event_type, left(query, 120) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))}`);
        await Bun.sleep(10);
      }
      await lock.unsafe("DELETE FROM workout_sessions WHERE id=$1", [doomed.id]);
      await lock.unsafe("COMMIT");
      committed = true;
    } finally { if (!committed) await lock.unsafe("ROLLBACK"); }
  } finally { lock.release(); }
  const listing = await reading as Listing;
  expect(listing.sessions.map(item => item.id)).not.toContain(doomed.id);
  expect(listing.sessions.find(item => item.id === kept.id)).toEqual(kept);
  expect(await stored(doomed.id)).toBeUndefined();
}, 60_000);
