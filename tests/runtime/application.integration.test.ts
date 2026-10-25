import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

test("restricted registration, query and page workers render the disposable PostgreSQL exercise data", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/exercises", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE exercises (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO exercises (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Squat')");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    const rendered = await app.render("/exercises");
    expect(rendered.html).toContain("<h1>Exercises</h1>");
    expect(rendered.html).toContain("Squat");
    expect(rendered.islands).toEqual([{ key: "island-0", id: "client/Counter.tsx#Counter", props: { name: "Squat" } }]);
    expect((await app.render("/exercises/00000000-0000-4000-8000-000000000001")).html).toContain("<h1>Squat</h1>");
    await fixture.sql.unsafe("INSERT INTO exercises (id,name) VALUES ('00000000-0000-4000-8000-000000000002','Row')");
    const first = await app.query("exercise.window", { locale: "en" }) as { names: string[]; cursor: string };
    const next = await app.query("exercise.window", { locale: "en", cursor: first.cursor }) as { names: string[] };
    expect(first.names).toEqual(["Squat"]);
    expect(next.names).toEqual(["Row"]);
    await expect(app.query("exercise.window", { locale: "fr", cursor: first.cursor })).rejects.toThrow("REQUEST_DENIED");
    await expect(app.render("/exercises/not-a-uuid")).rejects.toThrow("ROUTE_INVALID");
    await expect(app.query("exercise.list", { sql: "select *" })).rejects.toThrow("INPUT_INVALID");
  } finally { await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
