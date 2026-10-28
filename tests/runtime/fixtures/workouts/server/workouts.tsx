import { column, defineTable, eq, inArray, type ReadDb, type WriteDb } from "fleur/database";
import { handleMutation, handleQuery, inputError, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import type { Infer, UUID } from "fleur/schema";
import { createExercise, createTemplate, deleteExercise, deleteTemplate, listExercises, listTemplates, rejectTemplateOutput, template, templateEntry, templateEntryInput, templateEntryLimit, templatePageSize, updateTemplate } from "../shared/contracts";
import { laterTemplatesPage, templatesPage } from "../shared/pages";
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

export function trimmedName(value: string) {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return name;
}
handleQuery(listExercises, async ({ db }) => db.select(exercises, { fields: ["id", "name", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
handleMutation(createExercise, async ({ input, db }) => db.insert(exercises, { values: { name: trimmedName(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(deleteExercise, async ({ input, db }) => db.deleteVersioned(exercises, input));

type Template = Infer<typeof template>;
/** One joined statement: a template's header, ordered entries and exercise names share a snapshot. */
function readTemplateRows(db: ReadDb, id: UUID) {
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
    where: eq(templates.id, id),
    orderBy: [{ column: templateEntries.position, direction: "asc" }],
    limit: templateEntryLimit,
  });
}
async function readTemplate(db: ReadDb, id: UUID): Promise<Template> {
  const rows = await readTemplateRows(db, id);
  if (!rows[0]) throw new Error("Saved template is missing");
  return { id, name: rows[0].name, version: rows[0].version, entries: rows.map(row => ({ exerciseId: row.exerciseId, exerciseName: row.exerciseName, targetSets: row.targetSets, targetRepetitions: row.targetRepetitions })) };
}
async function insertEntries(db: WriteDb, templateId: UUID, entries: readonly Infer<typeof templateEntryInput>[]) {
  for (const [position, entry] of entries.entries()) await db.insert(templateEntries, { values: { templateId, position, ...entry }, returning: ["id"] });
}

const entryReadLimit = 500;
/** Ordered entries for one page of templates, in bounded reads of at most 500 rows. */
async function readEntries(db: ReadDb, ids: readonly UUID[]) {
  const selection = {
    from: templateEntries,
    joins: [{ type: "inner", table: exercises, on: eq(templateEntries.exerciseId, exercises.id) }] as const,
    fields: {
      entryId: templateEntries.id, templateId: templateEntries.templateId, position: templateEntries.position,
      exerciseId: exercises.id, exerciseName: exercises.name,
      targetSets: templateEntries.targetSets, targetRepetitions: templateEntries.targetRepetitions,
    },
    where: inArray(templateEntries.templateId, ids),
    orderBy: [{ column: templateEntries.templateId, direction: "asc" }, { column: templateEntries.position, direction: "asc" }],
  } as const;
  const entries = new Map<UUID, Infer<typeof templateEntry>[]>();
  let cursor: string | undefined;
  do {
    const rows = await db.selectJoined({ ...selection, limit: entryReadLimit, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of rows) entries.set(row.templateId, [...entries.get(row.templateId) ?? [], { exerciseId: row.exerciseId, exerciseName: row.exerciseName, targetSets: row.targetSets, targetRepetitions: row.targetRepetitions }]);
    const last = rows.length === entryReadLimit ? rows.at(-1) : undefined;
    cursor = last && db.cursorJoined({ ...selection, after: last });
  } while (cursor !== undefined);
  return entries;
}
// Headers and their entries are separate statements. A save committed between them can pair a
// header with newer entries; editing from that view then fails with VERSION_CONFLICT rather than
// overwriting, and the committed save triggers a refresh that shows the consistent result.
handleQuery(listTemplates, async ({ input, db }) => {
  const orderBy = [{ field: "name", direction: "asc" }] as const;
  const headers = await db.select(templates, { fields: ["id", "name", "version"], orderBy, limit: templatePageSize + 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  const page = headers.slice(0, templatePageSize), last = page.at(-1);
  const entries = page.length ? await readEntries(db, page.map(header => header.id)) : new Map<UUID, Infer<typeof templateEntry>[]>();
  return {
    templates: page.map(header => ({ ...header, entries: entries.get(header.id) ?? [] })),
    ...(headers.length > templatePageSize && last ? { cursor: db.cursor(templates, { orderBy, after: last }) } : {}),
  };
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
handleMutation(deleteTemplate, async ({ input, db }) => db.deleteVersioned(templates, input));
handleMutation(rejectTemplateOutput, async ({ input, db }) => {
  await replaceTemplate(db, input);
  return "server-private-canary" as unknown as boolean;
});

async function templatesView(cursor?: string) {
  const exerciseRows = await readQuery(listExercises, {}), listing = await readQuery(listTemplates, cursor === undefined ? {} : { cursor });
  return <main><h1>Workout templates</h1>
    <TemplateEditor key="new" exercises={exerciseRows} />
    {listing.cursor !== undefined && <Link to={laterTemplatesPage} params={{ cursor: listing.cursor }}>Later templates</Link>}
    {listing.templates.map(stored => <article key={stored.id}>
      <h2>{stored.name}</h2><p>Version {stored.version}</p>
      <ol>{stored.entries.map((entry, index) => <li key={index}>{entry.exerciseName}: {entry.targetSets} × {entry.targetRepetitions}</li>)}</ol>
      <TemplateEditor key={stored.id} exercises={exerciseRows} template={stored} />
    </article>)}
  </main>;
}
registerPage(templatesPage, { component: () => templatesView() });
registerPage(laterTemplatesPage, { component: ({ params }) => templatesView(params.cursor) });
