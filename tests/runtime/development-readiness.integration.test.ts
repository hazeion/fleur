import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { serveReadApplication } from "../../src/runtime/http";
import { verifyDevelopmentReadiness } from "../../src/runtime/development/readiness";
import { ownedPostgres } from "./owned-postgres";

// Public lifecycle operation with a real restricted application and disposable PG.
// This does not qualify the public dev prerequisite/profile gate or persistent storage.
test("readiness renders dynamic-only routes and accepts declared missing data while refusing failed rendering", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fleur-dynamic-readiness-"));
  let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
  let database: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  try {
    await mkdir(join(root, "shared")); await mkdir(join(root, "server"));
    await writeFile(join(root, "shared/pages.ts"), 'import { definePage } from "fleur/routing"; import { schema } from "fleur/schema"; export const catalog = definePage({path:"/catalog/:kind",params:schema.object({kind:schema.enum(["neutral", "other"])})}); export const detail = definePage({path:"/detail/:id",params:schema.object({id:schema.string().min(2048).max(2048)})});');
    const source = 'import {registerPage, publicError} from "fleur/server"; import {catalog,detail} from "../shared/pages"; registerPage(catalog,{component:({params}) => <h1>Catalog {params.kind}</h1>}); registerPage(detail,{component:() => {throw publicError("NOT_FOUND");}});';
    await writeFile(join(root, "server/pages.tsx"), source);
    const admitted = await admitProject(root), browser = await compileClient(admitted);
    images = await prepareNativeImages(await compileWorker(admitted));
    database = await ownedPostgres(); await database.reviewApplication(images, true);
    app = await ReadApplication.open(images, database.url); server = serveReadApplication(app, browser);
    for (let repeat = 0; repeat < 2; repeat++) {
      await verifyDevelopmentReadiness(app, browser, server.url).catch(async error => {
        const observed = await fetch(new URL("/catalog/neutral", server!.url));
        console.info("[dynamic-render-failure]", JSON.stringify({ status: observed.status, body: (await observed.text()).slice(0, 256) }));
        throw error;
      });
      expect((await fetch(new URL("/catalog/neutral", server.url))).status).toBe(200);
      expect((await fetch(new URL("/detail/"+"f".repeat(2048), server.url))).status).toBe(404);
    }
    let releaseStall!: () => void;
    const withheld = new Promise<Response>(resolve => { releaseStall = () => resolve(new Response("fixture released")); });
    const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => withheld });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probing = verifyDevelopmentReadiness(app, browser, stalled.url, AbortSignal.timeout(100)).then(() => "ready", error => error instanceof Error ? error.message : "unknown");
    try {
      const result = await Promise.race([probing, new Promise<string>(resolve => { timer = setTimeout(() => resolve("unbounded"), 1000); })]);
      expect(result).toBe("READINESS_TIMEOUT");
    } finally { clearTimeout(timer); releaseStall(); await stalled.stop(true); await probing; }
    await server.stop(true); server = undefined; await app.close(); app = undefined; await images.dispose(); images = undefined;
    await writeFile(join(root, "server/pages.tsx"), source.replace('<h1>Catalog {params.kind}</h1>', '(() => { throw new Error("render refused"); })()'));
    const failed = await admitProject(root);
    images = await prepareNativeImages(await compileWorker(failed));
    app = await ReadApplication.open(images, database.url); server = serveReadApplication(app, await compileClient(failed));
    await expect(verifyDevelopmentReadiness(app, browser, server.url)).rejects.toThrow("SOURCE_REJECTED");
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => server?.stop(true), () => app?.close(), () => database?.cleanup(), () => images?.dispose(), () => rm(root, { recursive: true, force: true })]) try { await cleanup(); } catch (error) { failures.push(error); }
    expect(failures, "Every dynamic readiness fixture retirement must be verified").toEqual([]);
  }
}, 180000);
