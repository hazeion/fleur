import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const templatesPage = definePage({ path: "/templates", params: schema.object({}) });
export const laterTemplatesPage = definePage({ path: "/templates/after/:cursor", params: schema.object({ cursor: schema.string() }) });
export const sessionsPage = definePage({ path: "/sessions", params: schema.object({}) });
export const earlierSessionsPage = definePage({ path: "/sessions/after/:cursor", params: schema.object({ cursor: schema.string() }) });
