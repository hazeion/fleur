import { useRef, useState } from "preact/hooks";
import { defineIsland, useMutation, type MutationOutcome } from "fleur/client";
import { schema, type Infer, type Input, type Schema } from "fleur/schema";
import { Link } from "fleur/routing";
import { createSession, deleteSession, session, sessionSetLimit, templateOption, updateSession, weightUnit, weightValue } from "../shared/sessions";
import { sessionsPage } from "../shared/pages";

type Unit = "" | "kg" | "lb";
interface DraftSet { key: number; repetitions: string; weight: string; unit: Unit }
interface DraftExercise { key: number; name: string; sets: DraftSet[] }
type Details = Input<typeof createSession>;
const blankSet = (key: () => number): DraftSet => ({ key: key(), repetitions: "", weight: "", unit: "" });
const draftExercises = (key: () => number, stored?: Infer<typeof session>): DraftExercise[] => stored
  ? stored.exercises.map(exercise => ({ key: key(), name: exercise.name, sets: exercise.sets.map(set => ({ key: key(), repetitions: String(set.repetitions), weight: set.weight?.value ?? "", unit: set.weight?.unit ?? "" })) }))
  : [{ key: key(), name: "", sets: [blankSet(key)] }];
/** Copies a template's entries into the draft: target sets become that many sets of the target repetitions. */
const fromTemplate = (key: () => number, template: Infer<typeof templateOption>): DraftExercise[] => template.entries.map(entry => ({
  key: key(), name: entry.exerciseName,
  sets: Array.from({ length: Math.min(entry.targetSets, sessionSetLimit) }, () => ({ ...blankSet(key), repetitions: String(entry.targetRepetitions) })),
}));
function parsed<T>(check: Schema<T>, value: string): T | undefined {
  try { return check.parse(value); } catch { return undefined; }
}
// Contract validation rejects anything that is not a positive safe integer before sending.
const count = (value: string) => /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
const localDate = schema.localDate();
/** Builds contract input from the draft; weights stay exact text and are never converted to numbers. */
function prepare(date: string, templateName: string | undefined, exercises: readonly DraftExercise[]): Details | string {
  const day = parsed(localDate, date);
  if (day === undefined) return "Not sent: INPUT_INVALID";
  if (exercises.some(exercise => exercise.name === "")) return "Not sent: choose an exercise for every entry.";
  const snapshots: Details["exercises"] = [];
  for (const exercise of exercises) {
    const sets: Details["exercises"][number]["sets"] = [];
    for (const set of exercise.sets) {
      const repetitions = count(set.repetitions);
      if ((set.weight === "") !== (set.unit === "")) return "Not sent: enter both a weight and its unit, or neither.";
      if (set.weight === "") { sets.push({ repetitions }); continue; }
      const value = parsed(weightValue, set.weight), unit = parsed(weightUnit, set.unit);
      if (value === undefined || unit === undefined) return "Not sent: INPUT_INVALID";
      sets.push({ repetitions, weight: { value, unit } });
    }
    snapshots.push({ name: exercise.name, sets });
  }
  return { date: day, ...(templateName === undefined ? {} : { templateName }), exercises: snapshots };
}
function message(outcome: MutationOutcome<unknown>, success: string): string {
  if (outcome.status === "success") return success;
  if (outcome.status === "outcome-unknown") return "Outcome unknown. Reload stored sessions before deciding whether to try again.";
  if (outcome.delivery === "not-sent") return `Not sent: ${outcome.error.code}`;
  if (outcome.error.code === "VERSION_CONFLICT") return "VERSION_CONFLICT: this session changed elsewhere. Your draft is kept; review the stored version, then reapply your draft to it to save.";
  if (outcome.error.code === "NOT_FOUND") return "NOT_FOUND: this session was deleted.";
  return outcome.error.code;
}

/** Keyed by session id, so its draft, base version and focus survive server-content refreshes. */
export const SessionEditor = defineIsland({
  props: schema.object({ exercises: schema.array(schema.string()), templates: schema.array(templateOption).optional(), session: session.optional() }),
  component: ({ exercises: catalog, templates = [], session: stored }) => {
    const keys = useRef(0), key = () => keys.current++;
    const [date, setDate] = useState<string>(stored?.date ?? ""), [templateName, setTemplateName] = useState(stored?.templateName);
    const [exercises, setExercises] = useState(() => draftExercises(key, stored)), [chosen, setChosen] = useState("");
    // The draft keeps the version it was based on; newer props never replace it silently.
    const [baseVersion, setBaseVersion] = useState(stored?.version ?? 0), [status, setStatus] = useState("");
    const create = useMutation(createSession), update = useMutation(updateSession), remove = useMutation(deleteSession);
    const save = stored ? update : create;
    const pending = save.pending || remove.pending, uncertain = save.status === "outcome-unknown" || remove.status === "outcome-unknown";
    const changeExercise = (target: number, change: (exercise: DraftExercise) => DraftExercise) =>
      setExercises(current => current.map(exercise => exercise.key === target ? change(exercise) : exercise));
    const changeSet = (exerciseKey: number, setKey: number, value: Partial<Omit<DraftSet, "key">>) =>
      changeExercise(exerciseKey, exercise => ({ ...exercise, sets: exercise.sets.map(set => set.key === setKey ? { ...set, ...value } : set) }));
    return <form aria-label={stored ? "Edit session" : "New session"} onSubmit={async event => {
      event.preventDefault();
      const values = prepare(date, templateName, exercises);
      if (typeof values === "string") { setStatus(values); return; }
      const outcome = stored ? await update.run({ id: stored.id, expectedVersion: baseVersion, ...values }) : await create.run(values);
      setStatus(message(outcome, "Saved"));
      if (outcome.status !== "success") return;
      if (stored) setBaseVersion(outcome.data.version);
      else { setDate(""); setTemplateName(undefined); setChosen(""); setExercises(draftExercises(key)); }
    }}>
      <label>Date<input type="date" value={date} onInput={event => setDate(event.currentTarget.value)} /></label>
      {!stored && <>
        <label>Template<select value={chosen} onChange={event => setChosen(event.currentTarget.value)}>
          <option value="">Choose template</option>
          {templates.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label>
        <button type="button" disabled={chosen === ""} onClick={() => {
          const template = templates.find(option => option.id === chosen);
          if (!template) return;
          setTemplateName(template.name);
          setExercises(fromTemplate(key, template));
        }}>Use template</button>
      </>}
      {templateName !== undefined && <p>Source template: {templateName}</p>}
      {exercises.map((exercise, index) => <fieldset key={exercise.key} aria-label={`Exercise ${index + 1}`}>
        <label>Exercise<select value={exercise.name} onChange={event => { const name = event.currentTarget.value; changeExercise(exercise.key, current => ({ ...current, name })); }}>
          <option value="">Choose exercise</option>
          {[...new Set([...(exercise.name === "" ? [] : [exercise.name]), ...catalog])].map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {exercise.sets.map((set, setIndex) => <fieldset key={set.key} aria-label={`Set ${setIndex + 1}`}>
          <label>Repetitions<input inputMode="numeric" value={set.repetitions} onInput={event => changeSet(exercise.key, set.key, { repetitions: event.currentTarget.value })} /></label>
          <label>Weight<input inputMode="decimal" value={set.weight} onInput={event => changeSet(exercise.key, set.key, { weight: event.currentTarget.value })} /></label>
          <label>Unit<select value={set.unit} onChange={event => { const unit = event.currentTarget.value; changeSet(exercise.key, set.key, { unit: unit === "kg" || unit === "lb" ? unit : "" }); }}>
            <option value="">None</option><option value="kg">kg</option><option value="lb">lb</option>
          </select></label>
          <button type="button" disabled={exercise.sets.length === 1} onClick={() => changeExercise(exercise.key, current => ({ ...current, sets: current.sets.filter(item => item.key !== set.key) }))}>Remove set</button>
        </fieldset>)}
        <button type="button" onClick={() => changeExercise(exercise.key, current => ({ ...current, sets: [...current.sets, blankSet(key)] }))}>Add set</button>
        <button type="button" disabled={exercises.length === 1} onClick={() => setExercises(current => current.filter(item => item.key !== exercise.key))}>Remove exercise</button>
      </fieldset>)}
      <button type="button" onClick={() => setExercises(current => [...current, ...draftExercises(key)])}>Add exercise</button>
      <button type="submit" disabled={pending || uncertain}>{stored ? "Save session" : "Record session"}</button>
      <p role="status">{pending ? "Saving" : status}</p>
      {stored && stored.version > baseVersion && !pending && <button type="button" onClick={() => { setBaseVersion(stored.version); setStatus(""); }}>
        Reapply draft to version {stored.version}
      </button>}
      {stored && <button type="button" disabled={pending || uncertain} onClick={async () => setStatus(message(await remove.run({ id: stored.id, expectedVersion: baseVersion }), "Deleted"))}>Delete session</button>}
      {uncertain && <Link to={sessionsPage} params={{}}>Reload stored sessions</Link>}
    </form>;
  },
});
