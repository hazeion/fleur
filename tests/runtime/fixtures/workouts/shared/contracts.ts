import { defineMutation, defineQuery, schema } from "fleur/schema";

export const exercise = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger() });
export const listExercises = defineQuery({ name: "exercise.list", input: schema.object({}), output: schema.array(exercise) });
export const createExercise = defineMutation({ name: "exercise.create", input: schema.object({ name: schema.string() }), output: exercise });
export const deleteExercise = defineMutation({ name: "exercise.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });

/** One template holds 1–100 ordered entries, so a single bounded read returns it whole. */
export const templateEntryLimit = 100;
const target = schema.safeInteger().min(1);
export const templateEntryInput = schema.object({ exerciseId: schema.uuid(), targetSets: target, targetRepetitions: target });
const entries = schema.array(templateEntryInput).min(1).max(templateEntryLimit);
export const templateEntry = schema.object({ exerciseId: schema.uuid(), exerciseName: schema.string().min(1).max(100), targetSets: target, targetRepetitions: target });
export const template = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger().min(1), entries: schema.array(templateEntry).min(1).max(templateEntryLimit) });

/** Templates per listing page: 10 full templates stay within one 1 MiB result. */
export const templatePageSize = 10;
/** One page of whole templates in name order; `cursor` is present when later templates exist. */
export const listTemplates = defineQuery({ name: "template.list", input: schema.object({ cursor: schema.string().optional() }), output: schema.object({ templates: schema.array(template).max(templatePageSize), cursor: schema.string().optional() }) });
export const createTemplate = defineMutation({ name: "template.create", input: schema.object({ name: schema.string(), entries }), output: template });
/** Replaces the header and the whole ordered entry list under one expected aggregate version. */
export const updateTemplate = defineMutation({ name: "template.update", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(), entries }), output: template });
/** Verification fixture: performs a complete update, then returns invalid output that must roll it back. */
export const rejectTemplateOutput = defineMutation({ name: "template.rejectOutput", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(), entries }), output: schema.boolean() });
