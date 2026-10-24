import type { z } from "zod";
export const validators = new WeakMap<object, z.ZodType>();
export const objectFields = new WeakMap<object, readonly string[]>();
export const routeSchemas = new WeakSet<object>();
