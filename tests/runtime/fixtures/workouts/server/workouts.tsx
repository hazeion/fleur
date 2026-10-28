import { column, defineTable, eq, type ReadDb, type WriteDb } from "fleur/database";
import { handleMutation, handleQuery, inputError, readQuery, registerPage } from "fleur/server";
import type { Infer, UUID } from "fleur/schema";
import { createExercise, createTemplate, deleteExercise, listExercises, listTemplates, rejectTemplateOutput, template, templateEntryInput, templateEntryLimit, updateTemplate } from "../shared/contracts";
import { templatesPage } from "../shared/pages";
import { TemplateEditor } from "../client/TemplateEditor";

export const exercises = defineTable("exercises", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100).unique({ caseFold: true }),
} });
export const templates = defineTable("workout_templates", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100),
} });
export const templateEntries = defineTable("workout_template_entries", { columns: {
  id: column.uuid().primaryKey().generated(),
  templateId: column.uuid().references(templates.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  exerciseId: column.uuid().references(exercises.id, { onDelete: "restrict" }),
  targetSets: column.safeInteger(),
  targetRepetitions: column.safeInteger(),
} });

function trimmedName(value: string) {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return name;
}
handleQuery(listExercises, async ({ db }) => db.select(exercises, { fields: ["id", "name", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
handleMutation(createExercise, async ({ input, db }) => db.insert(exercises, { values: { name: trimmedName(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(deleteExercise, async ({ input, db }) => db.deleteVersioned(exercises, input));

type Template = Infer<typeof template>;
/** One joined statement: header, ordered entries and current exercise names share a snapshot. */
function readTemplates(db: ReadDb, options: { id?: UUID; limit: number }) {
  return db.selectJoined({
    from: templateEntries,
    joins: [
      { type: "inner", table: templates, on: eq(templateEntries.templateId, templates.id) },
      { type: "inner", table: exercises, on: eq(templateEntries.exerciseId, exercises.id) },
    ],
    fields: {
      id: templates.id, name: templates.name, version: templates.version,
      exerciseId: templateEntries.exerciseId, exerciseName: exercises.name,
      targetSets: templateEntries.targetSets, targetRepetitions: templateEntries.targetRepetitions,
    },
    ...(options.id === undefined ? {} : { where: eq(templates.id, options.id) }),
    orderBy: [{ column: templates.name, direction: "asc" }, { column: templates.id, direction: "asc" }, { column: templateEntries.position, direction: "asc" }],
    limit: options.limit,
  });
}
function grouped(rows: Awaited<ReturnType<typeof readTemplates>>): Template[] {
  const result: Template[] = [];
  for (const { id, name, version, ...entry } of rows) {
    const last = result.at(-1);
    if (last?.id === id) last.entries.push(entry);
    else result.push({ id, name, version, entries: [entry] });
  }
  return result;
}
async function readTemplate(db: ReadDb, id: UUID): Promise<Template> {
  const [found] = grouped(await readTemplates(db, { id, limit: templateEntryLimit }));
  if (!found) throw new Error("Saved template is missing");
  return found;
}
async function insertEntries(db: WriteDb, templateId: UUID, entries: readonly Infer<typeof templateEntryInput>[]) {
  for (const [position, entry] of entries.entries()) await db.insert(templateEntries, { values: { templateId, position, ...entry }, returning: ["id"] });
}

const listingLimit = 500;
handleQuery(listTemplates, async ({ db }) => {
  const rows = await readTemplates(db, { limit: listingLimit });
  const result = grouped(rows);
  // A full page may have cut the last template's entries; never present a partial template.
  const complete = rows.length < listingLimit;
  return { templates: complete ? result : result.slice(0, -1), complete };
});
handleMutation(createTemplate, async ({ input, db }) => {
  const { id } = await db.insert(templates, { values: { name: trimmedName(input.name) }, returning: ["id"] });
  await insertEntries(db, id, input.entries);
  return readTemplate(db, id);
});
async function replaceTemplate(db: WriteDb, input: Infer<typeof updateTemplate.input>) {
  // Lock and advance the aggregate version before reading or replacing entries. A competing
  // save waits on this row, then fails with VERSION_CONFLICT before it touches any entry.
  await db.updateVersioned(templates, { id: input.id, expectedVersion: input.expectedVersion, set: { name: trimmedName(input.name) }, returning: ["id"] });
  const existing = await db.select(templateEntries, { fields: ["id", "version"], where: eq(templateEntries.templateId, input.id), limit: templateEntryLimit });
  for (const entry of existing) await db.deleteVersioned(templateEntries, { id: entry.id, expectedVersion: entry.version });
  await insertEntries(db, input.id, input.entries);
  return readTemplate(db, input.id);
}
handleMutation(updateTemplate, async ({ input, db }) => replaceTemplate(db, input));
handleMutation(rejectTemplateOutput, async ({ input, db }) => {
  await replaceTemplate(db, input);
  return "server-private-canary" as unknown as boolean;
});

registerPage(templatesPage, { component: async () => {
  const exerciseRows = await readQuery(listExercises, {}), listing = await readQuery(listTemplates, {});
  return <main><h1>Workout templates</h1>
    <TemplateEditor key="new" exercises={exerciseRows} />
    {!listing.complete && <p>Only the first stored templates are shown.</p>}
    {listing.templates.map(stored => <article key={stored.id}>
      <h2>{stored.name}</h2><p>Version {stored.version}</p>
      <ol>{stored.entries.map((entry, index) => <li key={index}>{entry.exerciseName}: {entry.targetSets} × {entry.targetRepetitions}</li>)}</ol>
      <TemplateEditor key={stored.id} exercises={exerciseRows} template={stored} />
    </article>)}
  </main>;
} });
