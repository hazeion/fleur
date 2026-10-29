import { useRef, useState } from "preact/hooks";
import { defineIsland, useMutation, type MutationOutcome } from "fleur/client";
import { schema, type Infer, type Input, type Schema } from "fleur/schema";
import { Link } from "fleur/routing";
import { amountUnit, amountValue, createMeal, deleteMeal, meal, mealPortionLimit, recipeOption, updateMeal } from "../shared/meals";
import { mealsPage } from "../shared/pages";

type Unit = "" | "g" | "ml";
interface DraftPortion { key: number; count: string; amount: string; unit: Unit }
interface DraftIngredient { key: number; name: string; portions: DraftPortion[] }
type Details = Input<typeof createMeal>;
const blankPortion = (key: () => number): DraftPortion => ({ key: key(), count: "", amount: "", unit: "" });
const draftIngredients = (key: () => number, stored?: Infer<typeof meal>): DraftIngredient[] => stored
  ? stored.ingredients.map(item => ({ key: key(), name: item.name, portions: item.portions.map(part => ({ key: key(), count: String(part.count), amount: part.amount?.value ?? "", unit: part.amount?.unit ?? "" })) }))
  : [{ key: key(), name: "", portions: [blankPortion(key)] }];
/** Copies a recipe's steps into the draft: target portions become that many portions of the target count. */
const fromRecipe = (key: () => number, recipe: Infer<typeof recipeOption>): DraftIngredient[] => recipe.steps.map(step => ({
  key: key(), name: step.ingredientName,
  portions: Array.from({ length: Math.min(step.targetPortions, mealPortionLimit) }, () => ({ ...blankPortion(key), count: String(step.targetCount) })),
}));
function parsed<T>(check: Schema<T>, value: string): T | undefined {
  try { return check.parse(value); } catch { return undefined; }
}
// Contract validation rejects anything that is not a positive safe integer before sending.
const whole = (value: string) => /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
const localDate = schema.localDate();
/** Builds contract input from the draft; amounts stay exact text and are never converted to numbers. */
function prepare(date: string, recipeName: string | undefined, ingredients: readonly DraftIngredient[]): Details | string {
  const day = parsed(localDate, date);
  if (day === undefined) return "Not sent: INPUT_INVALID";
  if (ingredients.some(item => item.name === "")) return "Not sent: choose an ingredient for every entry.";
  const snapshots: Details["ingredients"] = [];
  for (const item of ingredients) {
    const portions: Details["ingredients"][number]["portions"] = [];
    for (const part of item.portions) {
      const count = whole(part.count);
      if ((part.amount === "") !== (part.unit === "")) return "Not sent: enter both an amount and its unit, or neither.";
      if (part.amount === "") { portions.push({ count }); continue; }
      const value = parsed(amountValue, part.amount), unit = parsed(amountUnit, part.unit);
      if (value === undefined || unit === undefined) return "Not sent: INPUT_INVALID";
      portions.push({ count, amount: { value, unit } });
    }
    snapshots.push({ name: item.name, portions });
  }
  return { date: day, ...(recipeName === undefined ? {} : { recipeName }), ingredients: snapshots };
}
function message(outcome: MutationOutcome<unknown>, success: string): string {
  if (outcome.status === "success") return success;
  if (outcome.status === "outcome-unknown") return "Outcome unknown. Reload stored meals before deciding whether to try again.";
  if (outcome.delivery === "not-sent") return `Not sent: ${outcome.error.code}`;
  if (outcome.error.code === "VERSION_CONFLICT") return "VERSION_CONFLICT: this meal changed elsewhere. Your draft is kept; review the stored version, then reapply your draft to it to save.";
  if (outcome.error.code === "NOT_FOUND") return "NOT_FOUND: this meal was deleted.";
  return outcome.error.code;
}

/** Keyed by meal id, so its draft, base version and focus survive server-content refreshes. */
export const MealEditor = defineIsland({
  props: schema.object({ ingredients: schema.array(schema.string()), recipes: schema.array(recipeOption).optional(), meal: meal.optional() }),
  component: ({ ingredients: catalog, recipes = [], meal: stored }) => {
    const keys = useRef(0), key = () => keys.current++;
    const [date, setDate] = useState<string>(stored?.date ?? ""), [recipeName, setRecipeName] = useState(stored?.recipeName);
    const [ingredients, setIngredients] = useState(() => draftIngredients(key, stored)), [chosen, setChosen] = useState("");
    // The draft keeps the version it was based on; newer props never replace it silently.
    const [baseVersion, setBaseVersion] = useState(stored?.version ?? 0), [status, setStatus] = useState("");
    const create = useMutation(createMeal), update = useMutation(updateMeal), remove = useMutation(deleteMeal);
    const save = stored ? update : create;
    const pending = save.pending || remove.pending, uncertain = save.status === "outcome-unknown" || remove.status === "outcome-unknown";
    const changeIngredient = (target: number, change: (item: DraftIngredient) => DraftIngredient) =>
      setIngredients(current => current.map(item => item.key === target ? change(item) : item));
    const changePortion = (ingredientKey: number, portionKey: number, value: Partial<Omit<DraftPortion, "key">>) =>
      changeIngredient(ingredientKey, item => ({ ...item, portions: item.portions.map(part => part.key === portionKey ? { ...part, ...value } : part) }));
    return <form aria-label={stored ? "Edit meal" : "New meal"} onSubmit={async event => {
      event.preventDefault();
      const values = prepare(date, recipeName, ingredients);
      if (typeof values === "string") { setStatus(values); return; }
      const outcome = stored ? await update.run({ id: stored.id, expectedVersion: baseVersion, ...values }) : await create.run(values);
      setStatus(message(outcome, "Saved"));
      if (outcome.status !== "success") return;
      if (stored) setBaseVersion(outcome.data.version);
      else { setDate(""); setRecipeName(undefined); setChosen(""); setIngredients(draftIngredients(key)); }
    }}>
      <label>Date<input type="date" value={date} onInput={event => setDate(event.currentTarget.value)} /></label>
      {!stored && <>
        <label>Recipe<select value={chosen} onChange={event => setChosen(event.currentTarget.value)}>
          <option value="">Choose recipe</option>
          {recipes.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>
        <button type="button" disabled={chosen === ""} onClick={() => {
          const recipe = recipes.find(option => option.id === chosen);
          if (!recipe) return;
          setRecipeName(recipe.name);
          setIngredients(fromRecipe(key, recipe));
        }}>Use recipe</button>
      </>}
      {recipeName !== undefined && <p>Source recipe: {recipeName}</p>}
      {ingredients.map((item, index) => <fieldset key={item.key} aria-label={`Ingredient ${index + 1}`}>
        <label>Ingredient<select value={item.name} onChange={event => { const name = event.currentTarget.value; changeIngredient(item.key, current => ({ ...current, name })); }}>
          <option value="">Choose ingredient</option>
          {[...new Set([...(item.name === "" ? [] : [item.name]), ...catalog])].map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {item.portions.map((part, portionIndex) => <fieldset key={part.key} aria-label={`Portion ${portionIndex + 1}`}>
          <label>Count<input inputMode="numeric" value={part.count} onInput={event => changePortion(item.key, part.key, { count: event.currentTarget.value })} /></label>
          <label>Amount<input inputMode="decimal" value={part.amount} onInput={event => changePortion(item.key, part.key, { amount: event.currentTarget.value })} /></label>
          <label>Unit<select value={part.unit} onChange={event => { const unit = event.currentTarget.value; changePortion(item.key, part.key, { unit: unit === "g" || unit === "ml" ? unit : "" }); }}>
            <option value="">None</option><option value="g">g</option><option value="ml">ml</option>
          </select></label>
          <button type="button" disabled={item.portions.length === 1} onClick={() => changeIngredient(item.key, current => ({ ...current, portions: current.portions.filter(other => other.key !== part.key) }))}>Remove portion</button>
        </fieldset>)}
        <button type="button" onClick={() => changeIngredient(item.key, current => ({ ...current, portions: [...current.portions, blankPortion(key)] }))}>Add portion</button>
        <button type="button" disabled={ingredients.length === 1} onClick={() => setIngredients(current => current.filter(other => other.key !== item.key))}>Remove ingredient</button>
      </fieldset>)}
      <button type="button" onClick={() => setIngredients(current => [...current, ...draftIngredients(key)])}>Add ingredient</button>
      <button type="submit" disabled={pending || uncertain}>{stored ? "Save meal" : "Record meal"}</button>
      <p role="status">{pending ? "Saving" : status}</p>
      {stored && stored.version > baseVersion && !pending && <button type="button" onClick={() => { setBaseVersion(stored.version); setStatus(""); }}>
        Reapply draft to version {stored.version}
      </button>}
      {stored && <button type="button" disabled={pending || uncertain} onClick={async () => setStatus(message(await remove.run({ id: stored.id, expectedVersion: baseVersion }), "Deleted"))}>Delete meal</button>}
      {uncertain && <Link to={mealsPage} params={{}}>Reload stored meals</Link>}
    </form>;
  },
});
