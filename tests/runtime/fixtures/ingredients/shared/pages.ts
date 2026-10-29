import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const ingredientsPage = definePage({ path: "/ingredients", params: schema.object({}) });
export const ingredientPage = definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.uuid() }) });
