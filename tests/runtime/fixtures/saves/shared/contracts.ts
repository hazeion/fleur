import { defineMutation, defineQuery, schema } from "fleur/schema";
export const exercise = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger() });
export const listExercises = defineQuery({ name: "exercise.list", input: schema.object({}), output: schema.array(exercise) });
export const createExercise = defineMutation({ name: "exercise.create", input: schema.object({ name: schema.string() }), output: exercise });
export const renameExercise = defineMutation({ name: "exercise.rename", input: schema.object({ id: schema.uuid(), name: schema.string(), expectedVersion: schema.safeInteger() }), output: exercise });
export const deleteExercise = defineMutation({ name: "exercise.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });
export const invalidOutput = defineMutation({ name: "exercise.invalid", input: schema.object({}), output: schema.boolean() });
