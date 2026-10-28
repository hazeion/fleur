import { useState } from "preact/hooks";
import { defineIsland, useMutation, type MutationOutcome } from "fleur/client";
import { schema, type Infer, type UUID } from "fleur/schema";
import { Link } from "fleur/routing";
import { createTemplate, exercise, template, updateTemplate } from "../shared/contracts";
import { templatesPage } from "../shared/pages";

interface DraftEntry { key: number; exerciseId: UUID | ""; targetSets: string; targetRepetitions: string }
let nextKey = 0;
const draftEntries = (stored?: Infer<typeof template>): DraftEntry[] => stored
  ? stored.entries.map(entry => ({ key: nextKey++, exerciseId: entry.exerciseId, targetSets: String(entry.targetSets), targetRepetitions: String(entry.targetRepetitions) }))
  : [{ key: nextKey++, exerciseId: "", targetSets: "", targetRepetitions: "" }];
// Contract validation rejects anything that is not a positive safe integer before sending.
const count = (value: string) => /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
function message(outcome: MutationOutcome<unknown>): string {
  if (outcome.status === "success") return "Saved";
  if (outcome.status === "outcome-unknown") return "Outcome unknown. Reload stored templates before deciding whether to try again.";
  if (outcome.delivery === "not-sent") return `Not sent: ${outcome.error.code}`;
  if (outcome.error.code === "VERSION_CONFLICT") return "VERSION_CONFLICT: this template changed elsewhere. Your draft is kept; reload stored templates to edit the current version.";
  if (outcome.error.code === "CONSTRAINT_CONFLICT") return "CONSTRAINT_CONFLICT: an exercise in this draft no longer exists.";
  return outcome.error.code;
}

/** Keyed by template id, so its draft, base version and focus survive server-content refreshes. */
export const TemplateEditor = defineIsland({
  props: schema.object({ exercises: schema.array(exercise), template: template.optional() }),
  component: ({ exercises, template: stored }) => {
    const [name, setName] = useState(stored?.name ?? ""), [entries, setEntries] = useState(() => draftEntries(stored));
    // The draft keeps the version it was based on; newer props never replace it silently.
    const [baseVersion, setBaseVersion] = useState(stored?.version ?? 0), [status, setStatus] = useState("");
    const create = useMutation(createTemplate), update = useMutation(updateTemplate);
    const save = stored ? update : create;
    const uncertain = save.status === "outcome-unknown";
    const change = (key: number, value: Partial<Omit<DraftEntry, "key">>) =>
      setEntries(current => current.map(entry => entry.key === key ? { ...entry, ...value } : entry));
    const move = (index: number, offset: number) => setEntries(current => {
      const next = [...current], [moved] = next.splice(index, 1);
      next.splice(index + offset, 0, moved!);
      return next;
    });
    return <form aria-label={stored ? "Edit template" : "New template"} onSubmit={async event => {
      event.preventDefault();
      const chosen = entries.flatMap(({ exerciseId, targetSets, targetRepetitions }) => exerciseId === "" ? [] : [{ exerciseId, targetSets: count(targetSets), targetRepetitions: count(targetRepetitions) }]);
      if (chosen.length !== entries.length) { setStatus("Not sent: choose an exercise for every entry."); return; }
      const values = { name, entries: chosen };
      const outcome = stored ? await update.run({ id: stored.id, expectedVersion: baseVersion, ...values }) : await create.run(values);
      setStatus(message(outcome));
      if (outcome.status !== "success") return;
      if (stored) setBaseVersion(outcome.data.version);
      else { setName(""); setEntries(draftEntries()); }
    }}>
      <label>Template name<input value={name} onInput={event => setName(event.currentTarget.value)} /></label>
      {entries.map((entry, index) => <fieldset key={entry.key} aria-label={`Entry ${index + 1}`}>
        <label>Exercise<select value={entry.exerciseId} onChange={event => change(entry.key, { exerciseId: exercises.find(option => option.id === event.currentTarget.value)?.id ?? "" })}>
          <option value="">Choose exercise</option>
          {exercises.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>
        <label>Sets<input inputMode="numeric" value={entry.targetSets} onInput={event => change(entry.key, { targetSets: event.currentTarget.value })} /></label>
        <label>Repetitions<input inputMode="numeric" value={entry.targetRepetitions} onInput={event => change(entry.key, { targetRepetitions: event.currentTarget.value })} /></label>
        <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
        <button type="button" disabled={index === entries.length - 1} onClick={() => move(index, 1)}>Move down</button>
        <button type="button" disabled={entries.length === 1} onClick={() => setEntries(current => current.filter(item => item.key !== entry.key))}>Remove</button>
      </fieldset>)}
      <button type="button" onClick={() => setEntries(current => [...current, ...draftEntries()])}>Add exercise</button>
      <button type="submit" disabled={save.pending || uncertain}>{stored ? "Save template" : "Create template"}</button>
      <p role="status">{save.pending ? "Saving" : status}</p>
      {uncertain && <Link to={templatesPage} params={{}}>Reload stored templates</Link>}
    </form>;
  },
});
