import { defineQuery, defineMutation, schema } from "fleur/schema";
export const item = schema.object({ id: schema.safeInteger(), name: schema.string(), version: schema.safeInteger() });
export const listItems = defineQuery({ name: "reactive.list", input: schema.object({}), output: schema.array(item) });
export const health = defineQuery({ name: "reactive.health", input: schema.object({ mode: schema.enum(["healthy", "large", "slow"]) }), output: schema.string() });
export const saveItem = defineMutation({ name: "reactive.save", input: schema.object({ id: schema.safeInteger(), name: schema.string(), expectedVersion: schema.safeInteger() }), output: item });
