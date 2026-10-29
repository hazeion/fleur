import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

test("restricted mutation validates both boundaries and rolls back invalid output", async () => {
  expect(typeof ReadApplication.prototype.mutate).toBe("function");
  const project = await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url)));
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE ingredients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    await expect(app.mutate("ingredient.create", { name: "Sage", extra: true })).rejects.toThrow("INPUT_INVALID");
    await expect(app.mutate("ingredient.create", { name: "   " })).rejects.toThrow("INPUT_INVALID");
    expect(await app.query("ingredient.list", {})).toEqual([]);
    const saved = await app.mutate("ingredient.create", { name: "  Sage  " }) as { id: string; name: string; version: number };
    expect(saved).toMatchObject({ name: "Sage", version: 1 });
    await expect(app.mutate("ingredient.invalid", {})).rejects.toThrow("INTERNAL_FAILURE");
    expect(await app.query("ingredient.list", {})).toEqual([saved]);
    expect(await app.mutate("ingredient.rename", { id: saved.id, expectedVersion: 1, name: "Rice" })).toEqual({ ...saved, name: "Rice", version: 2 });
    await expect(app.mutate("ingredient.delete", { id: saved.id, expectedVersion: 1 })).rejects.toThrow("VERSION_CONFLICT");
    expect(await app.mutate("ingredient.delete", { id: saved.id, expectedVersion: 2 })).toEqual({ deleted: true });
  } finally { await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
