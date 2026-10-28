import { useState } from "preact/hooks";
import { defineIsland, refreshRetrieval } from "fleur/client";
import { schema } from "fleur/schema";
import { forecast } from "../shared/contracts";

/** Asks the server view to retrieve again; the browser never contacts the provider. */
export const Refresh = defineIsland({ props: schema.object({ city: schema.string() }), component: ({ city }) => {
  const [status, setStatus] = useState("idle");
  return <div>
    <button onClick={async () => {
      setStatus("refreshing");
      const result = await refreshRetrieval(forecast, { city });
      setStatus(result.status === "success" ? "refreshed" : `failed ${result.error?.code ?? "unknown"}`);
    }}>Refresh weather</button>
    <p aria-label="Refresh status">{status}</p>
  </div>;
} });
