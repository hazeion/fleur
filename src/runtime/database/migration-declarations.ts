import { randomUUID } from "node:crypto";
import { admitProject } from "../build/admission";
import { compileWorker } from "../build/worker";
import { prepareNativeImages } from "../native/build";
import { startWorker } from "../native/host";
import { restoreManifest } from "../manifest-wire";

/** Application modules evaluate only in the existing irreversibly restricted worker. */
export async function migrationTables(project: string) {
  const images = await prepareNativeImages(await compileWorker(await admitProject(project)));
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker(images);
    const session = randomUUID();
    const result = await worker.run({ mode: "register", session }, () => { throw new Error("REQUEST_DENIED"); });
    if (!result || typeof result !== "object" || !("kind" in result) || result.kind !== "complete" || !("session" in result) || result.session !== session || !("sequence" in result) || result.sequence !== 0 || !("value" in result) || Object.keys(result).length !== 4) throw new Error("SOURCE_REJECTED");
    return restoreManifest(result.value).tables;
  } finally { try { await worker?.close(); } finally { await images.dispose(); } }
}
