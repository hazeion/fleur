import { defineMutation, defineQuery, schema } from "fleur/schema";

export const ingredient = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger() });
export const listIngredients = defineQuery({ name: "ingredient.list", input: schema.object({}), output: schema.array(ingredient) });
export const createIngredient = defineMutation({ name: "ingredient.create", input: schema.object({ name: schema.string() }), output: ingredient });
export const deleteIngredient = defineMutation({ name: "ingredient.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });

/** One recipe holds 1–100 ordered steps, so a single bounded read returns it whole. */
export const recipeStepLimit = 100;
const target = schema.safeInteger().min(1);
/** A step uses one ingredient: `targetPortions` portions of `targetCount` each. */
export const recipeStepInput = schema.object({ ingredientId: schema.uuid(), targetPortions: target, targetCount: target });
const steps = schema.array(recipeStepInput).min(1).max(recipeStepLimit);
export const recipeStep = schema.object({ ingredientId: schema.uuid(), ingredientName: schema.string().min(1).max(100), targetPortions: target, targetCount: target });
export const recipe = schema.object({ id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger().min(1), steps: schema.array(recipeStep).min(1).max(recipeStepLimit) });

/** Recipes per listing page: 10 full recipes stay within one 1 MiB result. */
export const recipePageSize = 10;
/** One page of whole recipes in name order; `cursor` is present when later recipes exist. */
export const listRecipes = defineQuery({ name: "recipe.list", input: schema.object({ cursor: schema.string().optional() }), output: schema.object({ recipes: schema.array(recipe).max(recipePageSize), cursor: schema.string().optional() }) });
export const createRecipe = defineMutation({ name: "recipe.create", input: schema.object({ name: schema.string(), steps }), output: recipe });
/** Replaces the header and the whole ordered step list under one expected aggregate version. */
export const updateRecipe = defineMutation({ name: "recipe.update", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(), steps }), output: recipe });
/** Deletes a recipe and its steps. Recorded meals keep their own copies and are unaffected. */
export const deleteRecipe = defineMutation({ name: "recipe.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });
/** Verification fixture: performs a complete update, then returns invalid output that must roll it back. */
export const rejectRecipeOutput = defineMutation({ name: "recipe.rejectOutput", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(), steps }), output: schema.boolean() });
