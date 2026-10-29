// Inferred contract fixtures for the recipe fixture's ordered aggregate (#31, #102). Checked with tests/runtime/tsconfig.json
// against the fixture's own contracts and tables; the generated reference check covers contracts.types.ts.
import { schema, type Input, type Output } from "../../src/schema";
import { useMutation } from "../../src/client";
import type { WriteDb } from "../../src/database";
import { listRecipes, updateRecipe } from "./fixtures/recipes/shared/contracts";
import { recipeSteps } from "./fixtures/recipes/server/recipes";
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
function recipeTypes(db: WriteDb) {
  const save: Input<typeof updateRecipe> = { id, expectedVersion: 1, name: "Pancakes", steps: [{ ingredientId: id, targetPortions: 3, targetCount: 5 }] };
  // @ts-expect-error A recipe save carries its expected aggregate version.
  const unversioned: Input<typeof updateRecipe> = { id, name: "Pancakes", steps: save.steps };
  // @ts-expect-error Step ingredients are UUID references, not arbitrary strings.
  const arbitrary: Input<typeof updateRecipe>["steps"][number] = { ingredientId: "flour", targetPortions: 3, targetCount: 5 };
  // @ts-expect-error Step targets are numbers, not numeric strings.
  const textual: Input<typeof updateRecipe>["steps"][number] = { ingredientId: id, targetPortions: "3", targetCount: 5 };
  const listed = (listing: Output<typeof listRecipes>) => {
    const name: string = listing.recipes[0]!.steps[0]!.ingredientName;
    const version: number = listing.recipes[0]!.version;
    const cursor: string | undefined = listing.cursor;
    return [name, version, cursor] as const;
  };
  const nextPage: Input<typeof listRecipes> = { cursor: "opaque" };
  // @ts-expect-error Listing continuation is an opaque string cursor, not a page number.
  const numbered: Input<typeof listRecipes> = { cursor: 2 };
  useMutation(updateRecipe).run(save);
  // @ts-expect-error Client input requires the ordered step list.
  useMutation(updateRecipe).run({ id, expectedVersion: 1, name: "Pancakes" });
  db.insert(recipeSteps, { values: { recipeId: id, position: 0, ingredientId: id, targetPortions: 3, targetCount: 5 }, returning: ["id"] });
  // @ts-expect-error Step rows require their parent recipe reference.
  db.insert(recipeSteps, { values: { position: 0, ingredientId: id, targetPortions: 3, targetCount: 5 }, returning: ["id"] });
  void [unversioned, arbitrary, textual, listed, nextPage, numbered];
}
void recipeTypes;
