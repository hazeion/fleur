import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const recipesPage = definePage({ path: "/recipes", params: schema.object({}) });
export const laterRecipesPage = definePage({ path: "/recipes/after/:cursor", params: schema.object({ cursor: schema.string() }) });
export const mealsPage = definePage({ path: "/meals", params: schema.object({}) });
export const earlierMealsPage = definePage({ path: "/meals/after/:cursor", params: schema.object({ cursor: schema.string() }) });
