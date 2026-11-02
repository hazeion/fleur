import { expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { nativeCommand } from "../../src/runtime/native/command";
import { startWorker } from "../../src/runtime/native/host";
import { NativeExecution } from "../../src/runtime/native/execution";

test("a private host umask still produces readable immutable runtime sources for the unprivileged worker", async () => {
  const previous = process.umask(0o077);
  let images: Awaited<ReturnType<typeof prepareNativeImages>>;
  let buildMask = 0;
  try {
    images = await prepareNativeImages("module.exports.run = async () => ({kind:'complete',value:'restricted runtime'});");
    buildMask = process.umask();
  } finally { process.umask(previous); }
  const owner = crypto.randomUUID(), name = `fleur-image-access-${owner}`;
  const command = (args: string[]) => nativeCommand(["docker", "--host", images.endpoint, ...args]);
  try {
    expect(buildMask).toBe(0o077);
    const child = Bun.spawn(["docker", "--host", images.endpoint, "run", "--name", name, "--label", `fleur.issue38.image-access-owner=${owner}`, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never", "--entrypoint=bun", images.worker, "-e",
      'for(const path of ["/probe/bootstrap.js","/probe/application.js"]) await Bun.file(path).text(); const writable=await Bun.write("/probe/bootstrap.js","unexpected-write").then(()=>true,()=>false);console.log(JSON.stringify({uid:process.getuid(),readable:true,writable}));'],
    { stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(output)).toEqual({ uid: 65534, readable: true, writable: false });
    const worker = await startWorker(images);
    try { expect(await worker.run({}, () => null)).toEqual({ kind: "complete", value: "restricted runtime" }); }
    finally { await worker.close(); }
    const retained = await NativeExecution.open(images, { capacity: 1 });
    try { expect((await retained.execute({}, () => null)).value).toEqual({ kind: "complete", value: "restricted runtime" }); }
    finally { await retained.close(); }
  } finally {
    const found = await command(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]);
    if (found) {
      const [metadata] = JSON.parse(await command(["inspect", found]));
      expect(metadata.Name).toBe(`/${name}`);
      expect(metadata.Image).toBe(images.worker);
      expect(metadata.Config.Labels["fleur.issue38.image-access-owner"]).toBe(owner);
      await command(["rm", "--force", metadata.Id]);
    }
    await images.dispose();
  }
}, 300000);
