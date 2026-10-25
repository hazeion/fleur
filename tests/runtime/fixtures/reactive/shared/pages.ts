import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const reactivePage = definePage({ path: "/reactive", params: schema.object({}) });
export const otherPage = definePage({ path: "/other", params: schema.object({}) });
