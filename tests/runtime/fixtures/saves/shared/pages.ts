import { schema } from "fleur/schema";
import { definePage } from "fleur/routing";
export const ingredientsPage = definePage({ path: "/ingredients", params: schema.object({}) });
