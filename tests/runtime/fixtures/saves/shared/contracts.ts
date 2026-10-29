import { defineMutation, defineQuery, schema } from "fleur/schema";
export const ingredient = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger() });
export const listIngredients = defineQuery({ name: "ingredient.list", input: schema.object({}), output: schema.array(ingredient) });
export const createIngredient = defineMutation({ name: "ingredient.create", input: schema.object({ name: schema.string() }), output: ingredient });
export const renameIngredient = defineMutation({ name: "ingredient.rename", input: schema.object({ id: schema.uuid(), name: schema.string(), expectedVersion: schema.safeInteger() }), output: ingredient });
export const deleteIngredient = defineMutation({ name: "ingredient.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });
export const invalidOutput = defineMutation({ name: "ingredient.invalid", input: schema.object({}), output: schema.boolean() });
