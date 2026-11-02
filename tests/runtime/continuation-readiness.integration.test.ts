import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { serveReadApplication } from "../../src/runtime/http";
import { verifyDevelopmentReadiness } from "../../src/runtime/development/readiness";
import { ownedPostgres } from "./owned-postgres";

test("reactive rendering preserves denied continuations so a page can return declared NOT_FOUND", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-continuation-ready-")));
  let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
  let database: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  try {
    await mkdir(join(root, "shared")); await mkdir(join(root, "server"));
    await writeFile(join(root, "shared/pages.ts"), 'import {definePage} from "fleur/routing"; import {schema,defineQuery} from "fleur/schema"; export const list=defineQuery({name:"item.list",input:schema.object({cursor:schema.string().optional()}),output:schema.array(schema.string())}); export const home=definePage({path:"/items",params:schema.object({})}); export const later=definePage({path:"/items/after/:cursor",params:schema.object({cursor:schema.string()})});');
    await writeFile(join(root, "server/pages.tsx"), `import {column,defineTable} from "fleur/database";
import {handleQuery,readQuery,registerPage,publicError} from "fleur/server";
import {list,home,later} from "../shared/pages";
export const items=defineTable("items",{columns:{id:column.safeInteger().primaryKey(),name:column.string()}});
handleQuery(list,async({db,input})=>(await db.select(items,{fields:["name"],limit:1,...(input.cursor===undefined?{}:{cursor:input.cursor})})).map(row=>row.name));
const view=async(cursor?:string)=><main><h1>Items</h1>{(await readQuery(list,cursor===undefined?{}:{cursor})).join(",")}</main>;
registerPage(home,{component:()=>view()});
registerPage(later,{component:async({params})=>{try{return await view(params.cursor);}catch(error){if(error instanceof Error&&error.message==="REQUEST_DENIED")throw publicError("NOT_FOUND");throw error;}}});
`);
    const admitted = await admitProject(root), browser = await compileClient(admitted);
    images = await prepareNativeImages(await compileWorker(admitted));
    database = await ownedPostgres(); await database.reviewApplication(images, true);
    app = await ReadApplication.open(images, database.url); server = serveReadApplication(app, browser);
    for (let repeat = 1; repeat <= 2; repeat++) {
      const deadline = performance.now() + 60000;
      for (;;) {
        const response = await fetch(new URL("/items", server.url));
        if (response.ok) break;
        expect((await response.json() as { error: { code: string } }).error.code).toBe("QUERY_TIMEOUT");
        if (performance.now() >= deadline) throw new Error("Positive read did not become available");
      }
      const missing = await fetch(new URL("/items/after/f", server.url));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND" } });
      await verifyDevelopmentReadiness(app, browser, server.url);
    }
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => server?.stop(true), () => app?.close(), () => database?.cleanup(), () => images?.dispose(), () => rm(root, { recursive: true, force: true })]) try { await cleanup(); } catch (error) { failures.push(error); }
    expect(failures, "All owned continuation fixture resources must retire").toEqual([]);
  }
}, 180000);
