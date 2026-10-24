import { expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { startWorker } from "../../src/runtime/native/host";

test("top-level application evaluation occurs only after native authority is removed", async () => {
  const images = await prepareNativeImages(`
    const denied = Bun.file('/etc/passwd').text().then(() => false, () => true);
    module.exports.run = async () => ({kind: 'complete', value: {denied: await denied, secret: process.env.FLEUR_PRIVATE_DATABASE_URL ?? null}});
  `);
  const worker = await startWorker(images).catch(async error => { await images.dispose(); throw error; });
  try {
    const result = await worker.run({ mode: "test" }, () => { throw new Error("Unexpected exchange"); });
    expect(result).toEqual({ kind: "complete", value: { denied: true, secret: null } });
  } finally { await worker.close(); await images.dispose(); }
}, 300_000);
