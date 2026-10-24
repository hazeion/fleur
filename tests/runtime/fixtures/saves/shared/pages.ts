import { schema } from "fleur/schema";
import { definePage } from "fleur/routing";
export const exercisesPage = definePage({ path: "/exercises", params: schema.object({}) });
