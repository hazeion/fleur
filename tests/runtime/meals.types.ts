// Inferred contract fixtures for recorded meals (#32, #102). Checked with tests/runtime/tsconfig.json
// against the fixture's own contracts and tables. Exact decimals, LocalDate and Timestamp are
// distinct branded strings: none is interchangeable with arbitrary text or with each other.
import { schema, type DecimalString, type Input, type LocalDate, type Output, type Timestamp } from "../../src/schema";
import { useMutation } from "../../src/client";
import type { WriteDb } from "../../src/database";
import { createMeal, listMeals, updateMeal } from "./fixtures/recipes/shared/meals";
import { mealPortions, meals } from "./fixtures/recipes/server/meals";
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
const date = schema.localDate().parse("2026-10-28");
const grams = schema.decimal({ maxScale: 2, nonnegative: true }).parse("62.5");
const instant = schema.timestamp().parse("2026-10-28T09:00:00Z");
function mealTypes(db: WriteDb) {
  const record: Input<typeof createMeal> = { date, ingredients: [{ name: "Flour", portions: [{ count: 5, amount: { value: grams, unit: "g" } }, { count: 5 }] }] };
  const fromRecipe: Input<typeof createMeal> = { ...record, recipeName: "Pancakes" };
  // @ts-expect-error A meal date is a LocalDate, not arbitrary text.
  const textDate: Input<typeof createMeal> = { ...record, date: "2026-10-28" };
  // @ts-expect-error A Timestamp is not interchangeable with a LocalDate.
  const instantDate: Input<typeof createMeal> = { ...record, date: instant };
  // @ts-expect-error A LocalDate is not interchangeable with a Timestamp.
  const dateInstant: Timestamp = date;
  // @ts-expect-error An amount is an exact decimal string, never a JavaScript number.
  const numericAmount: Input<typeof createMeal>["ingredients"][number]["portions"][number] = { count: 5, amount: { value: 62.5, unit: "g" } };
  // @ts-expect-error An amount is a validated decimal string, not arbitrary text.
  const textAmount: Input<typeof createMeal>["ingredients"][number]["portions"][number] = { count: 5, amount: { value: "62.5", unit: "g" } };
  // @ts-expect-error A supplied amount requires its unit.
  const unitless: Input<typeof createMeal>["ingredients"][number]["portions"][number] = { count: 5, amount: { value: grams } };
  // @ts-expect-error Units are g or ml only.
  const kilograms: Input<typeof createMeal>["ingredients"][number]["portions"][number] = { count: 5, amount: { value: grams, unit: "kg" } };
  // @ts-expect-error A decimal is not interchangeable with a LocalDate.
  const decimalDate: LocalDate = grams;
  const save: Input<typeof updateMeal> = { id, expectedVersion: 1, ...record };
  // @ts-expect-error A meal save carries its expected aggregate version.
  const unversioned: Input<typeof updateMeal> = { id, ...record };
  const listed = (listing: Output<typeof listMeals>) => {
    const day: LocalDate = listing.meals[0]!.date;
    const amount: DecimalString | undefined = listing.meals[0]!.ingredients[0]!.portions[0]!.amount?.value;
    const recipe: string | undefined = listing.meals[0]!.recipeName;
    // @ts-expect-error A listed amount is an exact decimal string, not a number.
    const arithmetic: number = listing.meals[0]!.ingredients[0]!.portions[0]!.amount!.value;
    return [day, amount, recipe, arithmetic] as const;
  };
  useMutation(updateMeal).run(save);
  // @ts-expect-error Client input requires the ordered ingredient snapshots.
  useMutation(updateMeal).run({ id, expectedVersion: 1, date });
  db.insert(meals, { values: { date, recipeName: null }, returning: ["id"] });
  // @ts-expect-error Stored meal dates use the LocalDate column type.
  db.insert(meals, { values: { date: instant, recipeName: null }, returning: ["id"] });
  db.insert(mealPortions, { values: { mealIngredientId: id, position: 0, count: 5, amount: grams, unit: "g" }, returning: ["id"] });
  // @ts-expect-error Stored amounts are exact decimal strings.
  db.insert(mealPortions, { values: { mealIngredientId: id, position: 0, count: 5, amount: 62.5, unit: "g" }, returning: ["id"] });
  void [fromRecipe, textDate, instantDate, dateInstant, numericAmount, textAmount, unitless, kilograms, decimalDate, unversioned, listed];
}
void mealTypes;
