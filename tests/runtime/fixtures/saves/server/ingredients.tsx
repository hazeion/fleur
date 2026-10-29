import { column, defineTable } from "fleur/database";
import { handleQuery, handleMutation, inputError, readQuery, registerPage } from "fleur/server";
import { listIngredients, createIngredient, renameIngredient, deleteIngredient, invalidOutput } from "../shared/contracts";
export const ingredients = defineTable("ingredients", { columns: { id: column.uuid().primaryKey().generated(), name: column.string().max(100).unique({ caseFold: true }) } });
function normalized(value: string) {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return name;
}
handleQuery(listIngredients, async ({ db }) => db.select(ingredients, { fields: ["id", "name", "version"] }));
handleMutation(createIngredient, async ({ input, db }) => db.insert(ingredients, { values: { name: normalized(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(renameIngredient, async ({ input, db }) => db.updateVersioned(ingredients, { id: input.id, expectedVersion: input.expectedVersion, set: { name: normalized(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(deleteIngredient, async ({ input, db }) => db.deleteVersioned(ingredients, input));
handleMutation(invalidOutput, async ({ db }) => {
  await db.insert(ingredients, { values: { name: "Must roll back" }, returning: ["id"] });
  return "server-private-canary" as unknown as boolean;
});

import { Ingredients } from "../client/Ingredients";
import { ingredientsPage } from "../shared/pages";
registerPage(ingredientsPage, { component: async () => <main><h1>Ingredients</h1><Ingredients rows={await readQuery(listIngredients, {})} /></main> });
