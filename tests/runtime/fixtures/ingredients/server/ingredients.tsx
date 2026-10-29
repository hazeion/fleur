import { column, defineTable } from "fleur/database";
import { handleQuery, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import { listIngredients, ingredientWindow } from "../shared/contracts";
import { ingredientPage, ingredientsPage } from "../shared/pages";
import { Counter } from "../client/Counter";

export const ingredients = defineTable("ingredients", { columns: {
  id: column.uuid().primaryKey(), name: column.string().max(100), note: column.string().nullable(),
} });
export const serverImplementation = "server-only-implementation-canary";
handleQuery(listIngredients, async ({ db }) => db.select(ingredients, { fields: ["id", "name", "note", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
registerPage(ingredientsPage, { component: async () => {
  const rows = await readQuery(listIngredients, {});
  return <main><h1>Ingredients</h1><ul>{rows.map(row => <li key={row.id}>
    <Link to={ingredientPage} params={{ id: row.id }}>{row.name}</Link>
    <p>{row.note ?? "No notes"}</p><Counter name={row.name} />
  </li>)}</ul></main>;
} });
registerPage(ingredientPage, { component: async ({ params }) => {
  const rows = await readQuery(listIngredients, {});
  const row = rows.find(item => item.id === params.id);
  return <main><h1>{row?.name ?? "Ingredient not found"}</h1><Link to={ingredientsPage} params={{}}>All ingredients</Link></main>;
} });
handleQuery(ingredientWindow, async ({ db, input }) => {
  const rows = await db.select(ingredients, { fields: ["id", "name", "note", "version"], limit: 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  return { names: rows.map(row => row.name), ...(rows[0] ? { cursor: db.cursor(ingredients, { after: rows[0] }) } : {}) };
});
