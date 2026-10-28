import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const weatherPage = definePage({ path: "/weather/:city", params: schema.object({ city: schema.string() }) });
