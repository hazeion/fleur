import { column, defineTable, eq, inArray, type ReadDb, type WriteDb } from "fleur/database";
import { handleMutation, handleQuery, inputError, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import { schema, type DecimalString, type Infer, type LocalDate, type UUID } from "fleur/schema";
import { listExercises, listTemplates } from "../shared/contracts";
import { createSession, deleteSession, listSessions, normalizeDecimal, rejectSessionChild, rejectSessionOutput, session, sessionPageSize, sessionSetLimit, updateSession, weightUnit, weightValue, workoutSet } from "../shared/sessions";
import { earlierSessionsPage, sessionsPage } from "../shared/pages";
import { SessionEditor } from "../client/SessionEditor";
import { trimmedName } from "./workouts";

// A session is one aggregate of copied values. Its rows reference only their own parent rows,
// never exercises or templates, so later catalog or template edits and deletions cannot change it.
export const sessions = defineTable("workout_sessions", { columns: {
  id: column.uuid().primaryKey().generated(),
  date: column.localDate(),
  templateName: column.string().max(100).nullable(),
} });
export const sessionExercises = defineTable("workout_session_exercises", { columns: {
  id: column.uuid().primaryKey().generated(),
  sessionId: column.uuid().references(sessions.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  name: column.string().max(100),
} });
export const sessionSets = defineTable("workout_session_sets", { columns: {
  id: column.uuid().primaryKey().generated(),
  sessionExerciseId: column.uuid().references(sessionExercises.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  repetitions: column.safeInteger(),
  // Both null, or both present: the operation writes them together from one validated weight.
  weight: column.decimal({ precision: 7, scale: 2 }).nullable(),
  unit: column.string().max(2).nullable(),
} });

type Session = Infer<typeof session>;
type Details = Infer<typeof createSession.input>;
type WorkoutSet = Infer<typeof workoutSet>;
interface StoredSet { repetitions: number; weight: DecimalString | null; unit: string | null }

/** Normalizes stored-range weights textually; larger values are rejected rather than rounded. */
function storedWeight(value: DecimalString, field: string): DecimalString {
  const normalized = weightValue.parse(normalizeDecimal(value));
  if (normalized.split(".")[0]!.length > 5) throw inputError({ [field]: "Use a weight of at most 99999.99." });
  return normalized;
}
/** Validates and normalizes every copied value before the first write; errors name the field's input path. */
function snapshotOf(input: Details) {
  if (input.exercises.reduce((total, exercise) => total + exercise.sets.length, 0) > sessionSetLimit) throw inputError({ exercises: `Record at most ${sessionSetLimit} sets per session.` });
  return {
    date: input.date,
    templateName: input.templateName === undefined ? null : trimmedName(input.templateName, "templateName"),
    exercises: input.exercises.map((exercise, index) => ({
      name: trimmedName(exercise.name, `exercises.${index}.name`),
      sets: exercise.sets.map((set, setIndex): StoredSet => ({ repetitions: set.repetitions, weight: set.weight ? storedWeight(set.weight.value, `exercises.${index}.sets.${setIndex}.weight`) : null, unit: set.weight?.unit ?? null })),
    })),
  };
}
function publicSet(row: StoredSet): WorkoutSet {
  if (row.weight === null && row.unit === null) return { repetitions: row.repetitions };
  if (row.weight === null || row.unit === null) throw new Error("Stored weight and unit are incomplete");
  return { repetitions: row.repetitions, weight: { value: weightValue.parse(normalizeDecimal(row.weight)), unit: weightUnit.parse(row.unit) } };
}
interface Header { id: UUID; date: LocalDate; templateName: string | null; version: number }
interface SetRow extends StoredSet { exerciseId: UUID; name: string }
/** Groups position-ordered set rows into exercises; consecutive rows of one exercise row share its snapshot. */
function assemble(header: Header, rows: readonly SetRow[]): Session {
  const exercises: { id: UUID; name: string; sets: WorkoutSet[] }[] = [];
  for (const row of rows) {
    const current = exercises.at(-1);
    if (current?.id === row.exerciseId) current.sets.push(publicSet(row));
    else exercises.push({ id: row.exerciseId, name: row.name, sets: [publicSet(row)] });
  }
  return { id: header.id, date: header.date, ...(header.templateName === null ? {} : { templateName: header.templateName }), version: header.version, exercises: exercises.map(({ name, sets }) => ({ name, sets })) };
}
const setFields = { exerciseId: sessionExercises.id, name: sessionExercises.name, repetitions: sessionSets.repetitions, weight: sessionSets.weight, unit: sessionSets.unit } as const;
/** One joined statement: a session's header, exercises and sets share a snapshot. */
async function readSession(db: ReadDb, id: UUID): Promise<Session> {
  const rows = await db.selectJoined({
    from: sessionSets,
    joins: [
      { type: "inner", table: sessionExercises, on: eq(sessionSets.sessionExerciseId, sessionExercises.id) },
      { type: "inner", table: sessions, on: eq(sessionExercises.sessionId, sessions.id) },
    ],
    fields: { id: sessions.id, date: sessions.date, templateName: sessions.templateName, version: sessions.version, ...setFields },
    where: eq(sessions.id, id),
    orderBy: [{ column: sessionExercises.position, direction: "asc" }, { column: sessionSets.position, direction: "asc" }],
    limit: sessionSetLimit,
  });
  if (!rows[0]) throw new Error("Saved session is missing");
  return assemble(rows[0], rows);
}

const setReadLimit = 500;
/** Ordered sets for one page of sessions, in bounded reads of at most 500 rows. */
async function readSets(db: ReadDb, ids: readonly UUID[]) {
  const selection = {
    from: sessionSets,
    joins: [{ type: "inner", table: sessionExercises, on: eq(sessionSets.sessionExerciseId, sessionExercises.id) }] as const,
    fields: { setId: sessionSets.id, sessionId: sessionExercises.sessionId, exercisePosition: sessionExercises.position, setPosition: sessionSets.position, ...setFields },
    where: inArray(sessionExercises.sessionId, ids),
    orderBy: [{ column: sessionExercises.sessionId, direction: "asc" }, { column: sessionExercises.position, direction: "asc" }, { column: sessionSets.position, direction: "asc" }],
  } as const;
  const sets = new Map<UUID, SetRow[]>();
  let cursor: string | undefined;
  do {
    const rows = await db.selectJoined({ ...selection, limit: setReadLimit, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of rows) sets.set(row.sessionId, [...sets.get(row.sessionId) ?? [], row]);
    const last = rows.length === setReadLimit ? rows.at(-1) : undefined;
    cursor = last && db.cursorJoined({ ...selection, after: last });
  } while (cursor !== undefined);
  return sets;
}
// Headers and their sets are separate statements. A save committed between them can pair a
// header with newer sets; editing from that view then fails with VERSION_CONFLICT rather than
// overwriting, and the committed save triggers a refresh that shows the consistent result. A
// delete committed between them leaves a header without sets; omit it, since a session needs one.
handleQuery(listSessions, async ({ input, db }) => {
  const orderBy = [{ field: "date", direction: "desc" }] as const;
  const headers = await db.select(sessions, { fields: ["id", "date", "templateName", "version"], orderBy, limit: sessionPageSize + 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  const page = headers.slice(0, sessionPageSize), last = page.at(-1);
  const sets = page.length ? await readSets(db, page.map(header => header.id)) : new Map<UUID, SetRow[]>();
  return {
    sessions: page.flatMap(header => { const rows = sets.get(header.id); return rows ? [assemble(header, rows)] : []; }),
    ...(headers.length > sessionPageSize && last ? { cursor: db.cursor(sessions, { orderBy, after: last }) } : {}),
  };
});

async function insertExercises(db: WriteDb, sessionId: UUID, exercises: ReturnType<typeof snapshotOf>["exercises"]) {
  for (const [position, exercise] of exercises.entries()) {
    const { id } = await db.insert(sessionExercises, { values: { sessionId, position, name: exercise.name }, returning: ["id"] });
    for (const [setPosition, set] of exercise.sets.entries()) await db.insert(sessionSets, { values: { sessionExerciseId: id, position: setPosition, ...set }, returning: ["id"] });
  }
}
handleMutation(createSession, async ({ input, db }) => {
  const snapshot = snapshotOf(input);
  const { id } = await db.insert(sessions, { values: { date: snapshot.date, templateName: snapshot.templateName }, returning: ["id"] });
  await insertExercises(db, id, snapshot.exercises);
  return readSession(db, id);
});
async function replaceSession(db: WriteDb, input: Infer<typeof updateSession.input>) {
  const snapshot = snapshotOf(input);
  // Lock and advance the aggregate version before reading or replacing children. A competing
  // save waits on this row, then fails with VERSION_CONFLICT before it touches any child.
  await db.updateVersioned(sessions, { id: input.id, expectedVersion: input.expectedVersion, set: { date: snapshot.date, templateName: snapshot.templateName }, returning: ["id"] });
  const existing = await db.select(sessionExercises, { fields: ["id", "version"], where: eq(sessionExercises.sessionId, input.id), limit: sessionSetLimit });
  // Deleting an exercise row cascades to its sets.
  for (const exercise of existing) await db.deleteVersioned(sessionExercises, { id: exercise.id, expectedVersion: exercise.version });
  await insertExercises(db, input.id, snapshot.exercises);
  return readSession(db, input.id);
}
handleMutation(updateSession, async ({ input, db }) => replaceSession(db, input));
handleMutation(deleteSession, async ({ input, db }) => db.deleteVersioned(sessions, input));
const absentExercise = schema.uuid().parse("00000000-0000-4000-8000-000000000000");
handleMutation(rejectSessionChild, async ({ input, db }) => {
  await replaceSession(db, input);
  await db.insert(sessionSets, { values: { sessionExerciseId: absentExercise, position: 0, repetitions: 1, weight: null, unit: null }, returning: ["id"] });
  return readSession(db, input.id);
});
handleMutation(rejectSessionOutput, async ({ input, db }) => {
  await replaceSession(db, input);
  return "server-private-canary" as unknown as boolean;
});

const repetitions = (count: number) => `${count} rep${count === 1 ? "" : "s"}`;
const describe = (set: WorkoutSet) => set.weight ? `${repetitions(set.repetitions)} @ ${set.weight.value} ${set.weight.unit}` : repetitions(set.repetitions);
async function sessionsView(cursor?: string) {
  const exerciseRows = await readQuery(listExercises, {}), templateListing = await readQuery(listTemplates, {});
  const history = await readQuery(listSessions, cursor === undefined ? {} : { cursor });
  const exercises = exerciseRows.map(row => row.name);
  const templates = templateListing.templates.map(item => ({ id: item.id, name: item.name, entries: item.entries.map(({ exerciseName, targetSets, targetRepetitions }) => ({ exerciseName, targetSets, targetRepetitions })) }));
  return <main><h1>Workout sessions</h1>
    <SessionEditor key="new" exercises={exercises} templates={templates} />
    {history.cursor !== undefined && <Link to={earlierSessionsPage} params={{ cursor: history.cursor }}>Earlier sessions</Link>}
    {history.sessions.map(stored => <article key={stored.id}>
      <h2>Session on {stored.date}</h2>
      {stored.templateName !== undefined && <p>From template {stored.templateName}</p>}
      <p>Version {stored.version}</p>
      <ol>{stored.exercises.map((exercise, index) => <li key={index}>{exercise.name}: {exercise.sets.map(describe).join(", ")}</li>)}</ol>
      <SessionEditor key={stored.id} exercises={exercises} session={stored} />
    </article>)}
  </main>;
}
registerPage(sessionsPage, { component: () => sessionsView() });
registerPage(earlierSessionsPage, { component: ({ params }) => sessionsView(params.cursor) });
