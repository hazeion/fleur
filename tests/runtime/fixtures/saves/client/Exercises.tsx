import { useState } from "preact/hooks";
import { defineIsland, useMutation, type MutationOutcome } from "fleur/client";
import { schema, type Infer } from "fleur/schema";
import { Link } from "fleur/routing";
import { exercise, createExercise, renameExercise, deleteExercise } from "../shared/contracts";
import { exercisesPage } from "../shared/pages";

function message(outcome: MutationOutcome<unknown>): string {
  if (outcome.status === "success") return "Saved";
  if (outcome.status === "outcome-unknown") return "Outcome unknown. Refresh stored exercises before deciding whether to try again.";
  return outcome.delivery === "not-sent" ? `Not sent: ${outcome.error.code}` : outcome.error.code;
}
function ExerciseRow({ row, changed, report }: { row: Infer<typeof exercise>; changed(row: Infer<typeof exercise> | null): void; report(message: string): void }) {
  const [draft, setDraft] = useState(row.name);
  const rename = useMutation(renameExercise), remove = useMutation(deleteExercise);
  const uncertain = rename.status === "outcome-unknown" || remove.status === "outcome-unknown";
  return <li><span>{row.name}</span><input aria-label={`Rename ${row.name}`} value={draft} onInput={event => setDraft(event.currentTarget.value)} />
    <button disabled={rename.pending || remove.pending || uncertain} onClick={async () => {
      const result = await rename.run({ id: row.id, expectedVersion: row.version, name: draft });
      report(message(result));
      if (result.status === "success") changed(result.data);
    }}>Rename</button>
    <button disabled={rename.pending || remove.pending || uncertain} onClick={async () => {
      const result = await remove.run({ id: row.id, expectedVersion: row.version });
      report(message(result));
      if (result.status === "success") changed(null);
    }}>Delete</button></li>;
}
export const Exercises = defineIsland({ props: schema.object({ rows: schema.array(exercise) }), component: ({ rows: initial }) => {
  const [rows, setRows] = useState(initial), [name, setName] = useState(""), [status, setStatus] = useState("");
  const create = useMutation(createExercise);
  return <section><form onSubmit={async event => {
    event.preventDefault();
    const result = await create.run({ name });
    setStatus(message(result));
    if (result.status === "success") { setRows(rows => [...rows, result.data]); setName(""); }
  }}><label>New exercise name<input value={name} onInput={event => setName(event.currentTarget.value)} /></label>
    <button type="submit" disabled={create.pending || create.status === "outcome-unknown"}>Create exercise</button></form>
    <p role="status">{create.pending ? "Saving" : status}</p>
    <Link to={exercisesPage} params={{}}>Refresh stored exercises</Link>
    <ul>{rows.map(row => <ExerciseRow key={row.id} row={row} report={setStatus} changed={next => setRows(rows => next ? rows.map(item => item.id === row.id ? next : item) : rows.filter(item => item.id !== row.id))} />)}</ul>
  </section>;
} });
