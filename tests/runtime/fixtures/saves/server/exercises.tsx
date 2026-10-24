import { column, defineTable } from "fleur/database";
import { handleQuery, handleMutation, inputError, readQuery, registerPage } from "fleur/server";
import { listExercises, createExercise, renameExercise, deleteExercise, invalidOutput } from "../shared/contracts";
export const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey().generated(), name: column.string().max(100).unique({ caseFold: true }) } });
function normalized(value: string) {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return name;
}
handleQuery(listExercises, async ({ db }) => db.select(exercises, { fields: ["id", "name", "version"] }));
handleMutation(createExercise, async ({ input, db }) => db.insert(exercises, { values: { name: normalized(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(renameExercise, async ({ input, db }) => db.updateVersioned(exercises, { id: input.id, expectedVersion: input.expectedVersion, set: { name: normalized(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(deleteExercise, async ({ input, db }) => db.deleteVersioned(exercises, input));
handleMutation(invalidOutput, async ({ db }) => {
  await db.insert(exercises, { values: { name: "Must roll back" }, returning: ["id"] });
  return "server-private-canary" as unknown as boolean;
});

import { Exercises } from "../client/Exercises";
import { exercisesPage } from "../shared/pages";
registerPage(exercisesPage, { component: async () => <main><h1>Exercises</h1><Exercises rows={await readQuery(listExercises, {})} /></main> });
