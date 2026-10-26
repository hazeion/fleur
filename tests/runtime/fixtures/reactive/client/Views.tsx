import { useState, useEffect } from "preact/hooks";
import { defineIsland, useMutation, useQuery } from "fleur/client";
import { schema } from "fleur/schema";
import { item, listItems, health, saveItem } from "../shared/contracts";

export const Draft = defineIsland({ props: item, component: ({ id, name, version }) => {
  const [draft, setDraft] = useState(name), [clicks, setClicks] = useState(0), [mounts, setMounts] = useState(0);
  const [baseVersion, setBaseVersion] = useState(version);
  const save = useMutation(saveItem);
  useEffect(() => { setMounts(value => value + 1); }, []);
  return <section aria-label={`Draft ${id}`}><p>Stored: {name}</p><label>Draft {id}<input value={draft} onInput={event => setDraft(event.currentTarget.value)} /></label>
    <button onClick={() => setClicks(value => value + 1)}>Clicks {clicks}</button><span>Mounts {mounts}</span>
    <button onClick={async () => { const result = await save.run({ id, name: draft, expectedVersion: baseVersion }); if (result.status === "success") setBaseVersion(result.data.version); }}>Save {id}</button>
    <p aria-label={`Save status ${id}`}>{save.status}</p>
  </section>;
} });
export const QueryPanel = defineIsland({ props: schema.object({}), component: () => {
  const list = useQuery(listItems, {});
  const [mode, setMode] = useState<"healthy" | "large" | "slow">("healthy");
  const check = useQuery(health, { mode });
  return <aside><p aria-label="Live names">{list.data?.map(row => row.name).join(", ") ?? "Loading"}</p>
    <p aria-label="List status">{list.connection === "connected" ? list.status : list.connection} {list.stale ? "stale" : "current"}</p>
    <p aria-label="Health status">{check.status} {check.error?.code ?? check.data ?? "No data"}</p>
    <button onClick={() => setMode("large")}>Large query</button><button onClick={() => setMode("slow")}>Slow query</button><button onClick={() => setMode("healthy")}>Healthy query</button>
  </aside>;
} });
