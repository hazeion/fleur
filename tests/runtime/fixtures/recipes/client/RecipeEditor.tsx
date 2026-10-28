import { useRef, useState } from "preact/hooks";
import { defineIsland, useMutation, type MutationOutcome } from "fleur/client";
import { schema, type Infer, type UUID } from "fleur/schema";
import { Link } from "fleur/routing";
import { createRecipe, ingredient, recipe, updateRecipe } from "../shared/contracts";
import { recipesPage } from "../shared/pages";

interface DraftStep { key: number; ingredientId: UUID | ""; targetPortions: string; targetCount: string }
const draftSteps = (key: () => number, stored?: Infer<typeof recipe>): DraftStep[] => stored
  ? stored.steps.map(step => ({ key: key(), ingredientId: step.ingredientId, targetPortions: String(step.targetPortions), targetCount: String(step.targetCount) }))
  : [{ key: key(), ingredientId: "", targetPortions: "", targetCount: "" }];
// Contract validation rejects anything that is not a positive safe integer before sending.
const count = (value: string) => /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
function message(outcome: MutationOutcome<unknown>): string {
  if (outcome.status === "success") return "Saved";
  if (outcome.status === "outcome-unknown") return "Outcome unknown. Reload stored recipes before deciding whether to try again.";
  if (outcome.delivery === "not-sent") return `Not sent: ${outcome.error.code}`;
  if (outcome.error.code === "VERSION_CONFLICT") return "VERSION_CONFLICT: this recipe changed elsewhere. Your draft is kept; review the stored version, then reapply your draft to it to save.";
  if (outcome.error.code === "CONSTRAINT_CONFLICT") return "CONSTRAINT_CONFLICT: an ingredient in this draft no longer exists.";
  return outcome.error.code;
}

/** Keyed by recipe id, so its draft, base version and focus survive server-content refreshes. */
export const RecipeEditor = defineIsland({
  props: schema.object({ ingredients: schema.array(ingredient), recipe: recipe.optional() }),
  component: ({ ingredients, recipe: stored }) => {
    const keys = useRef(0), key = () => keys.current++;
    const [name, setName] = useState(stored?.name ?? ""), [steps, setSteps] = useState(() => draftSteps(key, stored));
    // The draft keeps the version it was based on; newer props never replace it silently.
    const [baseVersion, setBaseVersion] = useState(stored?.version ?? 0), [status, setStatus] = useState("");
    const create = useMutation(createRecipe), update = useMutation(updateRecipe);
    const save = stored ? update : create;
    const uncertain = save.status === "outcome-unknown";
    const change = (key: number, value: Partial<Omit<DraftStep, "key">>) =>
      setSteps(current => current.map(step => step.key === key ? { ...step, ...value } : step));
    const move = (index: number, offset: number) => setSteps(current => {
      const next = [...current], [moved] = next.splice(index, 1);
      next.splice(index + offset, 0, moved!);
      return next;
    });
    return <form aria-label={stored ? "Edit recipe" : "New recipe"} onSubmit={async event => {
      event.preventDefault();
      const chosen = steps.flatMap(({ ingredientId, targetPortions, targetCount }) => ingredientId === "" ? [] : [{ ingredientId, targetPortions: count(targetPortions), targetCount: count(targetCount) }]);
      if (chosen.length !== steps.length) { setStatus("Not sent: choose an ingredient for every step."); return; }
      const values = { name, steps: chosen };
      const outcome = stored ? await update.run({ id: stored.id, expectedVersion: baseVersion, ...values }) : await create.run(values);
      setStatus(message(outcome));
      if (outcome.status !== "success") return;
      if (stored) setBaseVersion(outcome.data.version);
      else { setName(""); setSteps(draftSteps(key)); }
    }}>
      <label>Recipe name<input value={name} onInput={event => setName(event.currentTarget.value)} /></label>
      {steps.map((step, index) => <fieldset key={step.key} aria-label={`Step ${index + 1}`}>
        <label>Ingredient<select value={step.ingredientId} onChange={event => change(step.key, { ingredientId: ingredients.find(option => option.id === event.currentTarget.value)?.id ?? "" })}>
          <option value="">Choose ingredient</option>
          {ingredients.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>
        <label>Portions<input inputMode="numeric" value={step.targetPortions} onInput={event => change(step.key, { targetPortions: event.currentTarget.value })} /></label>
        <label>Count<input inputMode="numeric" value={step.targetCount} onInput={event => change(step.key, { targetCount: event.currentTarget.value })} /></label>
        <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
        <button type="button" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>Move down</button>
        <button type="button" disabled={steps.length === 1} onClick={() => setSteps(current => current.filter(item => item.key !== step.key))}>Remove</button>
      </fieldset>)}
      <button type="button" onClick={() => setSteps(current => [...current, ...draftSteps(key)])}>Add ingredient</button>
      <button type="submit" disabled={save.pending || uncertain}>{stored ? "Save recipe" : "Create recipe"}</button>
      <p role="status">{save.pending ? "Saving" : status}</p>
      {stored && stored.version > baseVersion && !save.pending && <button type="button" onClick={() => { setBaseVersion(stored.version); setStatus(""); }}>
        Reapply draft to version {stored.version}
      </button>}
      {uncertain && <Link to={recipesPage} params={{}}>Reload stored recipes</Link>}
    </form>;
  },
});
