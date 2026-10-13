import { useEffect, useState } from "preact/hooks";
import type { IslandProps } from "./props";

export function Editor({ name }: IslandProps) {
  const [draft, setDraft] = useState(name);
  const [effects, setEffects] = useState(0);
  useEffect(() => { setEffects(count => count + 1); }, []);
  return <div>
    <label>Exercise draft<input value={draft} onInput={event => setDraft(event.currentTarget.value)} /></label>
    <span aria-label="Island saved name">{name}</span>
    <output aria-label="Client effects" data-effects={effects}>{effects}</output>
  </div>;
}
