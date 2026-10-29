import { defineMutation, defineQuery, schema } from "fleur/schema";

/** A meal records at most 50 portions in total, so one bounded read returns it whole. */
export const mealPortionLimit = 50;
/** Exact nonnegative decimal text with at most two places; never a JavaScript number. */
export const amountValue = schema.decimal({ maxScale: 2, nonnegative: true });
export const amountUnit = schema.enum(["g", "ml"]);
/** An amount carries its unit; omit the whole amount to record a portion without one. */
export const amount = schema.object({ value: amountValue, unit: amountUnit });
export const portion = schema.object({ count: schema.safeInteger().min(1), amount: amount.optional() });
const portions = schema.array(portion).min(1).max(mealPortionLimit);
const snapshotName = schema.string().min(1).max(100);
/** Snapshots name the ingredient as text: meals keep no reference to the catalog or a recipe. */
export const mealIngredientInput = schema.object({ name: schema.string(), portions });
export const mealIngredient = schema.object({ name: snapshotName, portions });
export const meal = schema.object({
  id: schema.uuid(), date: schema.localDate(), recipeName: snapshotName.optional(), version: schema.safeInteger().min(1),
  ingredients: schema.array(mealIngredient).min(1).max(mealPortionLimit),
});
const details = { date: schema.localDate(), recipeName: schema.string().optional(), ingredients: schema.array(mealIngredientInput).min(1).max(mealPortionLimit) };
const versionedDetails = schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger(), ...details });

/** Meals per history page: 20 meals of at most 50 portions stay within one 1 MiB result. */
export const mealPageSize = 20;
/** One page of whole meals, newest date first; `cursor` is present when earlier meals exist. */
export const listMeals = defineQuery({ name: "meal.list", input: schema.object({ cursor: schema.string().optional() }), output: schema.object({ meals: schema.array(meal).max(mealPageSize), cursor: schema.string().optional() }) });
export const createMeal = defineMutation({ name: "meal.create", input: schema.object(details), output: meal });
/** Replaces the date, source-recipe snapshot and every ingredient and portion under one expected aggregate version. */
export const updateMeal = defineMutation({ name: "meal.update", input: versionedDetails, output: meal });
export const deleteMeal = defineMutation({ name: "meal.delete", input: schema.object({ id: schema.uuid(), expectedVersion: schema.safeInteger() }), output: schema.object({ deleted: schema.boolean() }) });
/** Verification fixture: performs a complete update, then a child write that must fail and roll it back. */
export const rejectMealChild = defineMutation({ name: "meal.rejectChild", input: versionedDetails, output: meal });
/** Verification fixture: performs a complete update, then returns invalid output that must roll it back. */
export const rejectMealOutput = defineMutation({ name: "meal.rejectOutput", input: versionedDetails, output: schema.boolean() });

/** A recipe offered as a starting point for a new meal; choosing one copies its steps into the draft. */
export const recipeOption = schema.object({
  id: schema.uuid(), name: snapshotName,
  steps: schema.array(schema.object({ ingredientName: snapshotName, targetPortions: schema.safeInteger().min(1), targetCount: schema.safeInteger().min(1) })).min(1).max(100),
});

/** Drops leading integer and trailing fractional zeroes from validated decimal text, without numeric conversion. */
export function normalizeDecimal(value: string): string {
  const [whole = "", fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=[0-9])/, ""), decimals = fraction.replace(/0+$/, "");
  return decimals === "" ? integer : `${integer}.${decimals}`;
}
