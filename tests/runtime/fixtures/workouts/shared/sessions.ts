import { defineMutation, defineQuery, schema } from "fleur/schema";

/** A session records at most 50 sets in total, so one bounded read returns it whole. */
export const sessionSetLimit = 50;
/** Exact nonnegative decimal text with at most two places; never a JavaScript number. */
export const weightValue = schema.decimal({ maxScale: 2, nonnegative: true });
export const weightUnit = schema.enum(["kg", "lb"]);
/** A weight carries its unit; omit the whole weight to record a set without one. */
export const weight = schema.object({ value: weightValue, unit: weightUnit });
export const workoutSet = schema.object({ repetitions: schema.safeInteger().min(1), weight: weight.optional() });
const sets = schema.array(workoutSet).min(1).max(sessionSetLimit);
const snapshotName = schema.string().min(1).max(100);
/** Snapshots name the exercise as text: sessions keep no reference to the catalog or a template. */
export const sessionExerciseInput = schema.object({ name: schema.string(), sets });
export const sessionExercise = schema.object({ name: snapshotName, sets });
export const session = schema.object({
  id: schema.uuid(), date: schema.localDate(), templateName: snapshotName.optional(), version: schema.safeInteger().min(1),
  exercises: schema.array(sessionExercise).min(1).max(sessionSetLimit),
});
const details = { date: schema.localDate(), templateName: schema.string().optional(), exercises: schema.array(sessionExerciseInput).min(1).max(sessionSetLimit) };
const versionedDetails = schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), ...details });

/** Sessions per history page: 20 sessions of at most 50 sets stay within one 1 MiB result. */
export const sessionPageSize = 20;
/** One page of whole sessions, newest date first; `cursor` is present when earlier sessions exist. */
export const listSessions = defineQuery({ name: "session.list", input: schema.object({ cursor: schema.string().optional() }), output: schema.object({ sessions: schema.array(session).max(sessionPageSize), cursor: schema.string().optional() }) });
export const createSession = defineMutation({ name: "session.create", input: schema.object(details), output: session });
/** Replaces the date, source-template snapshot and every exercise and set under one expected aggregate version. */
export const updateSession = defineMutation({ name: "session.update", input: versionedDetails, output: session });
export const deleteSession = defineMutation({ name: "session.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });
/** Verification fixture: performs a complete update, then a child write that must fail and roll it back. */
export const rejectSessionChild = defineMutation({ name: "session.rejectChild", input: versionedDetails, output: session });
/** Verification fixture: performs a complete update, then returns invalid output that must roll it back. */
export const rejectSessionOutput = defineMutation({ name: "session.rejectOutput", input: versionedDetails, output: schema.boolean() });

/** A template offered as a starting point for a new session; choosing one copies its entries into the draft. */
export const templateOption = schema.object({
  id: schema.uuid(), name: snapshotName,
  entries: schema.array(schema.object({ exerciseName: snapshotName, targetSets: schema.safeInteger().min(1), targetRepetitions: schema.safeInteger().min(1) })).min(1).max(100),
});

/** Drops leading integer and trailing fractional zeroes from validated decimal text, without numeric conversion. */
export function normalizeDecimal(value: string): string {
  const [whole = "", fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=[0-9])/, ""), decimals = fraction.replace(/0+$/, "");
  return decimals === "" ? integer : `${integer}.${decimals}`;
}
