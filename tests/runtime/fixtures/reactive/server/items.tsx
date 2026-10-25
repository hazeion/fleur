import { column, defineTable } from "fleur/database";
import { handleQuery, handleMutation, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import { listItems, health, saveItem } from "../shared/contracts";
import { reactivePage, otherPage } from "../shared/pages";
import { Draft, QueryPanel } from "../client/Views";
export const items = defineTable("reactive_items", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
export const serverCanary = "reactive-server-secret-canary";
handleQuery(listItems, async ({ db }) => db.select(items, { fields: ["id", "name", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
handleQuery(health, async ({ input }) => {
  if (input.mode === "large") return "x".repeat(1048577);
  if (input.mode === "slow") await new Promise(resolve => setTimeout(resolve, 6000));
  return "Healthy";
});
handleMutation(saveItem, async ({ input, db }) => db.updateVersioned(items, { id: input.id, expectedVersion: input.expectedVersion, set: { name: input.name }, returning: ["id", "name", "version"] }));
registerPage(reactivePage, { component: async () => {
  const rows = await readQuery(listItems, {});
  return <main><h1>Reactive items</h1><ul aria-label="Server names">{rows.map(row => <li key={row.id}><span>{row.name}</span><Draft {...row} /></li>)}</ul><QueryPanel /><Link to={otherPage} params={{}}>Other page</Link></main>;
} });
registerPage(otherPage, { component: () => <main><h1>Other page</h1><Link to={reactivePage} params={{}}>Reactive page</Link></main> });
