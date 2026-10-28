import { schema, type Infer, type LocalDate, type Timestamp } from "../../src/schema";
import { column, defineTable, type Row, type Insert } from "../../src/database";
const publicExercise = schema.object({ id: schema.uuid(), name: schema.string(), deleted: schema.boolean().nullable(), note: schema.string().optional() });
type Exercise = Infer<typeof publicExercise>;
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
const accepted: Exercise = { id, name: "Squat", deleted: null };
// @ts-expect-error Nullable remains required.
const missingNullable: Exercise = { id, name: "Squat" };
// @ts-expect-error UUID is validated, not an arbitrary string.
const arbitraryId: Exercise = { id: "wrong", name: "Squat", deleted: null };
const date: LocalDate = schema.localDate().parse("2024-02-29");
// @ts-expect-error LocalDate and Timestamp are distinct.
const instant: Timestamp = date;
const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey().generated(), name: column.string(), note: column.string().nullable() } });
const row: Row<typeof exercises> = { id, name: "Squat", note: null, version: 1 };
const insert: Insert<typeof exercises> = { name: "Squat", note: null };
// @ts-expect-error Managed version cannot be supplied for insert.
const badInsert: Insert<typeof exercises> = { name: "Squat", note: null, version: 1 };
// @ts-expect-error Required nullable column cannot be omitted.
const missingColumn: Insert<typeof exercises> = { name: "Squat" };
// @ts-expect-error Foreign key types must match.
column.safeInteger().references(exercises.id, { onDelete: "restrict" });
// @ts-expect-error Set-null requires a nullable source.
column.uuid().references(exercises.id, { onDelete: "set null" });
void [accepted, missingNullable, arbitraryId, instant, row, insert, badInsert, missingColumn];

import { defineQuery } from "../../src/schema";
import { eq, defineRelations } from "../../src/database";
import { definePage, href } from "../../src/routing";
import { defineIsland } from "../../src/client";
import { h } from "preact";
const list = defineQuery({ input: schema.object({ count: schema.safeInteger() }), output: schema.array(publicExercise) });
const page = definePage({ path: "/exercises/:id", params: schema.object({ id: schema.uuid() }) });
href(page, { id });
// @ts-expect-error Required route parameter cannot be omitted.
href(page, {});
// @ts-expect-error Path placeholders must match the declared schema.
definePage({ path: "/exercises/:wrong", params: schema.object({ id: schema.uuid() }) });
// @ts-expect-error Filter value follows the column type.
eq(exercises.name, 1);
const Name = defineIsland({ props: schema.object({ name: schema.string() }), component: ({ name }) => h("span", null, name) });
// @ts-expect-error Island props are contextually inferred.
Name({ name: 4 }, {});
// @ts-expect-error Relation references require matching column types.
defineRelations(exercises, ({ one }) => ({ invalid: one(exercises, { fields: [exercises.name], references: [exercises.id] }) }));
void list;
// @ts-expect-error Optional path parameters do not satisfy a required placeholder.
definePage({ path: "/exercises/:id", params: schema.object({ id: schema.string().optional() }) });
// @ts-expect-error Route parameters must be string-compatible.
definePage({ path: "/exercises/:id", params: schema.object({ id: schema.safeInteger() }) });

import type { ReadDb } from "../../src/database";
function readContract(db: ReadDb) {
  const result: Promise<{ id: typeof id; name: string }[]> = db.select(exercises, { fields: ["id", "name"], limit: 100 });
  // @ts-expect-error Selection fields must exist on the table.
  db.select(exercises, { fields: ["secret"] });
  // @ts-expect-error Read handlers receive no write capability.
  db.insert(exercises, { values: { name: "bad", note: null }, returning: ["id"] });
  // @ts-expect-error Read handlers cannot open transactions.
  db.transaction(() => {});
  // @ts-expect-error Read handlers cannot obtain raw SQL connections.
  db.connection();
  return result;
}
void readContract;

import { alias } from "../../src/database";
const tags = defineTable("tags", { columns: { id: column.safeInteger().primaryKey(), exerciseId: column.uuid().references(exercises.id, { onDelete: "restrict" }), label: column.string() } });
function joinedContract(db: ReadDb) {
  const e = alias(exercises, "e"), t = alias(tags, "t");
  const result = db.selectJoined({ from: e, joins: [{ type: "left", table: t, on: eq(e.id, t.exerciseId) }], fields: { exercise: e.name, tag: t.label } });
  const correct: Promise<{ exercise: string; tag: string | null }[]> = result;
  // @ts-expect-error Left-joined fields can be absent even when the stored column is required.
  const nonnullable: Promise<{ exercise: string; tag: string }[]> = result;
  void nonnullable;
  return correct;
}
void joinedContract;

function relationAndCursorContract(db: ReadDb) {
  const parent = defineTable("parent", { columns: { id: column.safeInteger().primaryKey() } });
  const child = defineTable("child", { columns: { id: column.safeInteger().primaryKey(), parentId: column.safeInteger().references(parent.id, { onDelete: "restrict" }) } });
  defineRelations(parent, ({ one }) => ({
    // @ts-expect-error Relation fields belong to the source, references to the target.
    backwards: one(child, { fields: [child.parentId], references: [parent.id] }),
  }));
  const cursor = db.cursor(parent, { after: { id: 1 } });
  // @ts-expect-error Cursor table identity must match the selected table.
  db.select(child, { fields: ["id"], cursor });
}
void relationAndCursorContract;

import { defineMutation } from "../../src/schema";
import { handleMutation } from "../../src/server";
import { useMutation, useQuery } from "../../src/client";
import type { WriteDb } from "../../src/database";
const saveContract = defineMutation({ input: schema.object({ name: schema.string() }), output: schema.boolean() });
handleMutation(saveContract, async ({ input }) => input.name.length > 0);
// @ts-expect-error Handler output is inferred from the contract.
handleMutation(saveContract, async () => "wrong");
function mutationTypes(db: WriteDb) {
  const mutation = useMutation(saveContract);
  mutation.run({ name: "Squat" });
  // @ts-expect-error Client input is inferred.
  mutation.run({ name: 1 });
  const generated = defineTable("generated", { columns: { id: column.uuid().generated().primaryKey(), name: column.string() } });
  const defaulted = defineTable("defaulted", { columns: { id: column.uuid().generated().primaryKey(), name: column.string().default("Initial"), changed: column.timestamp().defaultNow() } });
  db.updateVersioned(defaulted, { id, expectedVersion: 1, set: { name: "Edited", changed: schema.timestamp().parse("2026-10-24T12:34:56Z") }, returning: ["name", "changed"] });
  // @ts-expect-error Defaulted columns retain their value types on update.
  db.updateVersioned(defaulted, { id, expectedVersion: 1, set: { name: 4 }, returning: ["name"] });
  const managedOnly = defineTable("managed_only", { columns: { id: column.uuid().generated().primaryKey() } });
  // @ts-expect-error A table containing only managed fields still rejects assignments.
  db.updateVersioned(managedOnly, { id, expectedVersion: 1, set: { id }, returning: ["id"] });
  // @ts-expect-error Generated branding survives fluent declaration order.
  db.insert(generated, { values: { id, name: "Forbidden" }, returning: ["id"] });
  // @ts-expect-error Managed version cannot be assigned.
  db.updateVersioned(exercises, { id, expectedVersion: 1, set: { version: 3 }, returning: ["id"] });
  // @ts-expect-error Expected version is mandatory.
  db.deleteVersioned(exercises, { id });
  // @ts-expect-error Versioned tables cannot use unversioned writes.
  db.update(exercises, { id, set: { name: "Wrong" }, returning: ["id"] });
  const unversioned = defineTable("unversioned", { versioned: false, columns: { id: column.uuid().primaryKey(), name: column.string() } });
  // @ts-expect-error Unversioned tables cannot use versioned writes.
  db.updateVersioned(unversioned, { id, expectedVersion: 1, set: { name: "Wrong" }, returning: ["id"] });
  // @ts-expect-error Primary keys cannot be changed.
  db.update(unversioned, { id, set: { id }, returning: ["id"] });
  db.update(unversioned, { id, set: { name: "Allowed" }, returning: ["id"] });
}
void mutationTypes;
function reactiveTypes() {
  const result = useQuery(list, { count: 10 });
  const data: readonly Exercise[] | undefined = result.data;
  const refreshing: boolean = result.refreshing;
  void data; void refreshing;
  // @ts-expect-error Query input derives from its contract.
  useQuery(list, { count: "10" });
  // @ts-expect-error Mutation contracts are not reactive read contracts.
  useQuery(saveContract, { name: "test" });
  // @ts-expect-error Output remains the inferred public exercise array.
  const wrong: number = result.data;
  void wrong;
}
void reactiveTypes;

import { defineSeed } from "../../src/database";
const typedSeed = defineSeed({ key: "exercises", table: exercises, rows: [{ ownerKey: "squat", values: { name: "Squat", note: null } }] });
const seedName: string = typedSeed.rows[0]!.values.name;
void seedName;
// @ts-expect-error Seed values retain the table's inferred insert types.
defineSeed({ key: "invalid", table: exercises, rows: [{ ownerKey: "bad", values: { name: 4, note: null } }] });
// @ts-expect-error Seed values cannot assign a managed version.
defineSeed({ key: "invalid", table: exercises, rows: [{ ownerKey: "bad", values: { name: "Squat", note: null, version: 4 } }] });

import { defineRetrieval } from "../../src/schema";
import { defineDestination, handleRetrieval, readRetrieval, RetrievalError } from "../../src/server";
import { refreshRetrieval } from "../../src/client";
const forecastContract = defineRetrieval({ input: schema.object({ city: schema.string() }), output: schema.object({ temperature: schema.number().nullable() }) });
const forecastApi = defineDestination({ origin: "https://api.weather.example", path: "/v1/forecast/:city", response: schema.object({ temperature: schema.number() }) });
const statusApi = defineDestination({ origin: "https://status.example", path: "/health", response: schema.object({ ok: schema.boolean() }) });
handleRetrieval(forecastContract, async ({ input, external }) => {
  const response = await external.get(forecastApi, { params: { city: input.city } });
  const temperature: number = response.body.temperature;
  const health = await external.get(statusApi);
  const ok: boolean = health.body.ok;
  const metadata = await external.head(statusApi);
  // @ts-expect-error HEAD returns declared metadata without a body.
  void metadata.body;
  // @ts-expect-error A templated path requires its parameters.
  await external.get(forecastApi);
  // @ts-expect-error Parameter names follow the declared path template.
  await external.get(forecastApi, { params: { town: "x" } });
  // @ts-expect-error The response body is the declared schema, not an arbitrary value.
  const wrongBody: string = response.body.temperature;
  void [ok, wrongBody];
  return { temperature };
});
// @ts-expect-error Retrieval handlers receive no database authority.
handleRetrieval(forecastContract, async ({ db }) => { void db; return { temperature: null }; });
// @ts-expect-error Retrieval output follows its contract.
handleRetrieval(forecastContract, async () => ({ temperature: "warm" }));
async function retrievalReaders() {
  const value = await readRetrieval(forecastContract, { city: "Paris" });
  const temperature: number | null = value.temperature;
  // @ts-expect-error Retrieval input derives from its contract.
  await readRetrieval(forecastContract, { town: "Paris" });
  const refreshed = await refreshRetrieval(forecastContract, { city: "Paris" });
  const status: "success" | "error" = refreshed.status;
  // @ts-expect-error Client refresh input derives from the contract.
  await refreshRetrieval(forecastContract, { city: 1 });
  const failure = new RetrievalError("RETRIEVAL_HTTP_FAILURE", 503);
  const code: "RETRIEVAL_DESTINATION_DENIED" | "RETRIEVAL_REDIRECT_DENIED" | "RETRIEVAL_TIMEOUT" | "RETRIEVAL_HTTP_FAILURE" | "RETRIEVAL_TRANSPORT_FAILURE" | "RETRIEVAL_TOO_LARGE" | "RETRIEVAL_INVALID_OUTPUT" = failure.code;
  void [temperature, status, code];
}
void retrievalReaders;
