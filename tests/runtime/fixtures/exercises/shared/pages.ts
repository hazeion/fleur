import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const exercisesPage = definePage({ path: "/exercises", params: schema.object({}) });
export const exercisePage = definePage({ path: "/exercises/:id", params: schema.object({ id: schema.uuid() }) });
