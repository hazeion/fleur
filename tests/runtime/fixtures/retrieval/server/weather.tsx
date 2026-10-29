import { column, defineTable, eq } from "fleur/database";
import { defineDestination, handleMutation, handleQuery, handleRetrieval, readQuery, readRetrieval, registerPage, RetrievalError } from "fleur/server";
import { schema } from "fleur/schema";
import { directNetwork, forecast, listReadings, rebound, retrieveInMutation, saveReading, spin, strictForecast } from "../shared/contracts";
import { latePage, slowPage, weatherPage } from "../shared/pages";
import { Refresh } from "../client/Refresh";

export const readings = defineTable("weather_readings", { columns: {
  id: column.uuid().primaryKey().generated(), city: column.string().max(64), temperature: column.safeInteger(),
} });
// The trusted host binds the "weather" credential to this exact origin and
// admits this local test origin; neither is application-controlled.
export const weatherApi = defineDestination({
  name: "weather.api", origin: "http://weather.fixture.test:4173", path: "/v1/forecast/:city",
  response: schema.object({ temperature: schema.safeInteger() }), credential: "weather",
});
export const reboundApi = defineDestination({ name: "weather.rebound-api", origin: "https://rebound.fixture.test:4173", path: "/v1/forecast/paris", response: schema.object({ temperature: schema.safeInteger() }) });
export const serverCanary = "retrieval-server-only-canary";

handleRetrieval(forecast, async ({ input, external }) => {
  try {
    const response = await external.get(weatherApi, { params: { city: input.city } });
    return { city: input.city, temperature: response.body.temperature, available: true };
  } catch (error) {
    // An unavailable provider is an explicit state, never an empty reading.
    if (error instanceof RetrievalError) return { city: input.city, temperature: null, available: false };
    throw error;
  }
});
handleRetrieval(strictForecast, async ({ input, external }) => ({ city: input.city, temperature: (await external.get(weatherApi, { params: { city: input.city } })).body.temperature }));
handleRetrieval(rebound, async ({ external }) => { await external.get(reboundApi); return true; });
// Attempts direct network access from the isolated worker. It must not reach the host.
handleRetrieval(directNetwork, async ({ input }) => {
  let environment = false;
  try { environment = typeof process !== "undefined" && JSON.stringify(process.env).includes("fixture-weather-secret"); } catch { environment = false; }
  if (!input.network) return { network: [], environment };
  const network: string[] = [];
  for (const target of ["http://host.docker.internal:4174/direct", "http://172.17.0.1:4174/direct", "http://127.0.0.1:4174/direct"]) {
    try { await fetch(target); network.push("allowed"); } catch { network.push("denied"); }
  }
  return { network, environment };
});
// CPU-bound handler work that never yields; the worker operation deadline ends it.
handleRetrieval(spin, async () => { for (;;) { /* never yields */ } });
handleQuery(listReadings, async ({ input, db }) => (await db.select(readings, { fields: ["id"], where: eq(readings.city, input.city) })).length);
// Retrieved data is saved by a subsequent mutation that revalidates it.
handleMutation(saveReading, async ({ input, db }) => db.insert(readings, { values: input, returning: ["id", "city", "temperature"] }));
handleMutation(retrieveInMutation, async () => { await readRetrieval(forecast, { city: "paris" }); return "unreachable"; });

// A page whose provider never answers; its nested retrieval must not outlive the render.
registerPage(slowPage, { component: async () => <p>{(await readRetrieval(strictForecast, { city: "slow" })).temperature}</p> });
// A page that reaches its retrieval late in the render, about two seconds before
// its deadline; the handler must still see RETRIEVAL_TIMEOUT and fall back.
registerPage(latePage, { component: async () => {
  await new Promise(resolve => setTimeout(resolve, 2500));
  const current = await readRetrieval(forecast, { city: "slow" });
  return <p aria-label="Temperature">{current.available ? `${current.temperature} degrees` : "Weather unavailable"}</p>;
} });
registerPage(weatherPage, { component: async ({ params }) => {
  const current = await readRetrieval(forecast, { city: params.city });
  const saved = await readQuery(listReadings, { city: params.city });
  return <main>
    <h1>Weather in {current.city}</h1>
    <p aria-label="Temperature">{current.available ? `${current.temperature} degrees` : "Weather unavailable"}</p>
    <p aria-label="Saved readings">Saved readings: {saved}</p>
    <Refresh city={params.city} />
  </main>;
} });
