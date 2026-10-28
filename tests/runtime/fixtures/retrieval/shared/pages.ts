import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const slowPage = definePage({ path: "/slow", params: schema.object({}) });
export const weatherPage = definePage({ path: "/weather/:city", params: schema.object({ city: schema.string() }) });
