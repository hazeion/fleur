// Inferred contract fixtures for workout sessions (#32). Checked with tests/runtime/tsconfig.json
// against the fixture's own contracts and tables. Exact decimals, LocalDate and Timestamp are
// distinct branded strings: none is interchangeable with arbitrary text or with each other.
import { schema, type DecimalString, type Input, type LocalDate, type Output, type Timestamp } from "../../src/schema";
import { useMutation } from "../../src/client";
import type { WriteDb } from "../../src/database";
import { createSession, listSessions, updateSession } from "./fixtures/workouts/shared/sessions";
import { sessionSets, sessions } from "./fixtures/workouts/server/sessions";
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
const date = schema.localDate().parse("2026-10-28");
const kilograms = schema.decimal({ maxScale: 2, nonnegative: true }).parse("62.5");
const instant = schema.timestamp().parse("2026-10-28T09:00:00Z");
function sessionTypes(db: WriteDb) {
  const record: Input<typeof createSession> = { date, exercises: [{ name: "Squat", sets: [{ repetitions: 5, weight: { value: kilograms, unit: "kg" } }, { repetitions: 5 }] }] };
  const fromTemplate: Input<typeof createSession> = { ...record, templateName: "Legs" };
  // @ts-expect-error A session date is a LocalDate, not arbitrary text.
  const textDate: Input<typeof createSession> = { ...record, date: "2026-10-28" };
  // @ts-expect-error A Timestamp is not interchangeable with a LocalDate.
  const instantDate: Input<typeof createSession> = { ...record, date: instant };
  // @ts-expect-error A LocalDate is not interchangeable with a Timestamp.
  const dateInstant: Timestamp = date;
  // @ts-expect-error A weight is an exact decimal string, never a JavaScript number.
  const numericWeight: Input<typeof createSession>["exercises"][number]["sets"][number] = { repetitions: 5, weight: { value: 62.5, unit: "kg" } };
  // @ts-expect-error A weight is a validated decimal string, not arbitrary text.
  const textWeight: Input<typeof createSession>["exercises"][number]["sets"][number] = { repetitions: 5, weight: { value: "62.5", unit: "kg" } };
  // @ts-expect-error A supplied weight requires its unit.
  const unitless: Input<typeof createSession>["exercises"][number]["sets"][number] = { repetitions: 5, weight: { value: kilograms } };
  // @ts-expect-error Units are kg or lb only.
  const grams: Input<typeof createSession>["exercises"][number]["sets"][number] = { repetitions: 5, weight: { value: kilograms, unit: "g" } };
  // @ts-expect-error A decimal is not interchangeable with a LocalDate.
  const decimalDate: LocalDate = kilograms;
  const save: Input<typeof updateSession> = { id, expectedVersion: 1, ...record };
  // @ts-expect-error A session save carries its expected aggregate version.
  const unversioned: Input<typeof updateSession> = { id, ...record };
  const listed = (listing: Output<typeof listSessions>) => {
    const day: LocalDate = listing.sessions[0]!.date;
    const weight: DecimalString | undefined = listing.sessions[0]!.exercises[0]!.sets[0]!.weight?.value;
    const template: string | undefined = listing.sessions[0]!.templateName;
    // @ts-expect-error A listed weight is an exact decimal string, not a number.
    const arithmetic: number = listing.sessions[0]!.exercises[0]!.sets[0]!.weight!.value;
    return [day, weight, template, arithmetic] as const;
  };
  useMutation(updateSession).run(save);
  // @ts-expect-error Client input requires the ordered exercise snapshots.
  useMutation(updateSession).run({ id, expectedVersion: 1, date });
  db.insert(sessions, { values: { date, templateName: null }, returning: ["id"] });
  // @ts-expect-error Stored session dates use the LocalDate column type.
  db.insert(sessions, { values: { date: instant, templateName: null }, returning: ["id"] });
  db.insert(sessionSets, { values: { sessionExerciseId: id, position: 0, repetitions: 5, weight: kilograms, unit: "kg" }, returning: ["id"] });
  // @ts-expect-error Stored weights are exact decimal strings.
  db.insert(sessionSets, { values: { sessionExerciseId: id, position: 0, repetitions: 5, weight: 62.5, unit: "kg" }, returning: ["id"] });
  void [fromTemplate, textDate, instantDate, dateInstant, numericWeight, textWeight, unitless, grams, decimalDate, unversioned, listed];
}
void sessionTypes;
