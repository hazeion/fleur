import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

test("restricted registration, query and page workers render the disposable PostgreSQL ingredient data", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/ingredients", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE ingredients (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO ingredients (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Sage')");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    const rendered = await app.render("/ingredients");
    expect(rendered.html).toContain("<h1>Ingredients</h1>");
    expect(rendered.html).toContain("Sage");
    expect(rendered.islands).toEqual([{ key: "island-0", id: "client/Counter.tsx#Counter", props: { name: "Sage" } }]);
    expect((await app.render("/ingredients/00000000-0000-4000-8000-000000000001")).html).toContain("<h1>Sage</h1>");
    await fixture.sql.unsafe("INSERT INTO ingredients (id,name) VALUES ('00000000-0000-4000-8000-000000000002','Rice')");
    const first = await app.query("ingredient.window", { locale: "en" }) as { names: string[]; cursor: string };
    const next = await app.query("ingredient.window", { locale: "en", cursor: first.cursor }) as { names: string[] };
    expect(first.names).toEqual(["Sage"]);
    expect(next.names).toEqual(["Rice"]);
    await expect(app.query("ingredient.window", { locale: "fr", cursor: first.cursor })).rejects.toThrow("REQUEST_DENIED");
    await expect(app.render("/ingredients/not-a-uuid")).rejects.toThrow("ROUTE_INVALID");
    await expect(app.query("ingredient.list", { sql: "select *" })).rejects.toThrow("INPUT_INVALID");
  } finally { await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
