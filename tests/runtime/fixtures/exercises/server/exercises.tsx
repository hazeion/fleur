import { column, defineTable } from "fleur/database";
import { handleQuery, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import { listExercises, exerciseWindow } from "../shared/contracts";
import { exercisePage, exercisesPage } from "../shared/pages";
import { Counter } from "../client/Counter";

export const exercises = defineTable("exercises", { columns: {
  id: column.uuid().primaryKey(), name: column.string().max(100), note: column.string().nullable(),
} });
export const serverImplementation = "server-only-implementation-canary";
handleQuery(listExercises, async ({ db }) => db.select(exercises, { fields: ["id", "name", "note", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
registerPage(exercisesPage, { component: async () => {
  const rows = await readQuery(listExercises, {});
  return <main><h1>Exercises</h1><ul>{rows.map(row => <li key={row.id}>
    <Link to={exercisePage} params={{ id: row.id }}>{row.name}</Link>
    <p>{row.note ?? "No notes"}</p><Counter name={row.name} />
  </li>)}</ul></main>;
} });
registerPage(exercisePage, { component: async ({ params }) => {
  const rows = await readQuery(listExercises, {});
  const row = rows.find(item => item.id === params.id);
  return <main><h1>{row?.name ?? "Exercise not found"}</h1><Link to={exercisesPage} params={{}}>All exercises</Link></main>;
} });
handleQuery(exerciseWindow, async ({ db, input }) => {
  const rows = await db.select(exercises, { fields: ["id", "name", "note", "version"], limit: 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  return { names: rows.map(row => row.name), ...(rows[0] ? { cursor: db.cursor(exercises, { after: rows[0] }) } : {}) };
});
