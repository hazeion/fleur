import { z } from "zod";
const uuid = z.string().uuid();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dependency = z.strictObject({ name: z.string().min(1).max(256), input: z.unknown() });
export const refreshRequest = z.strictObject({ connection: uuid, page: uuid, generation: counter, sequence: counter, queries: z.array(dependency).max(100), force: z.boolean().optional() });
export const viewRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open"), path: z.string().min(1).max(8192) }),
  refreshRequest.extend({ action: z.literal("refresh") }),
  z.strictObject({ action: z.literal("dispose"), connection: uuid, page: uuid }),
]);
export const viewIdentity = z.strictObject({ connection: uuid, page: uuid, generation: counter, sequence: counter, epoch: uuid, revision: z.string().regex(/^(0|[1-9][0-9]*)$/), status: z.enum(["current", "stale", "refreshing"]) });
export const viewResponse = viewIdentity.extend({
  renderError: z.string().max(64).optional(),
  rendered: z.strictObject({ html: z.string().max(1048576), islands: z.array(z.strictObject({ key: z.string().regex(/^island-[0-9]{1,3}$/), id: z.string().max(8192), props: z.unknown() })).max(500), regions: z.array(z.strictObject({ id: z.string().max(8192), dependencies: z.array(dependency).max(100), error: z.string().max(64).optional() })).max(500) }),
  queries: z.array(dependency.extend({ status: z.enum(["current", "error", "loading", "refreshing"]), stale: z.boolean(), data: z.unknown().optional(), error: z.string().max(64).optional() })).max(100),
});
export type ViewIdentity = z.infer<typeof viewIdentity>;
