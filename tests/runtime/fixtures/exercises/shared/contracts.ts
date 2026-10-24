import { defineQuery, schema } from "fleur/schema";
export const listExercises = defineQuery({
  name: "exercise.list",
  input: schema.object({}),
  output: schema.array(schema.object({ id: schema.uuid(), name: schema.string(), note: schema.string().nullable(), version: schema.safeInteger() })),
});
export const exerciseWindow = defineQuery({
  name: "exercise.window",
  input: schema.object({ cursor: schema.string().optional(), locale: schema.string() }),
  output: schema.object({ names: schema.array(schema.string()), cursor: schema.string().optional() }),
});
