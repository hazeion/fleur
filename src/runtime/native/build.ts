import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { selectedEndpoint, type NativeImages } from "./endpoint";
import { nativeCommand } from "./command";

/**
 * Digest-pinned registry bases of the controller and worker stages, keyed like `process.arch`. CI pre-pulls each one
 * (scripts/pull-pinned-development-images.ts) so development start never waits on a live registry pull (#182).
 */
export const nativeBaseImages: Readonly<Record<"arm64" | "x64", { readonly controller: string; readonly worker: string }>> = {
  arm64: { controller: "ubuntu@sha256:18b33ff3829707f31ada654a963b9ee35f2e6f0241b964bd17a22a9b330cb63d", worker: "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" },
  x64: { controller: "ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc", worker: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e" },
};

export interface DevelopmentImageOwnership {
  readonly binding: string;
  record(record: { owner: string; endpoint: string; directory: string; stage: "controller" | "worker" | "complete"; controller: string | null; worker: string | null }): Promise<void>;
  release(owner: string): Promise<void>;
}
/** Explicit build-time acquisition; serving never installs packages or builds images. */
export async function prepareNativeImages(application: string, development?: DevelopmentImageOwnership): Promise<NativeImages & { dispose(): Promise<void> }> {
  if (development !== undefined && !/^[a-f0-9]{64}$/.test(development.binding)) throw new Error("REQUEST_DENIED");
  const lifecycleLabel = development ? `LABEL dev.fleur.development-binding=${development.binding}\n` : "";
  const endpoint = await selectedEndpoint();
  let buildUnconfirmed = false;
  const command = async (args: string[]) => {
    try { return await nativeCommand([args[0]!, "--host", endpoint, ...args.slice(1)], args[1] === "build" ? 300_000 : 5000); }
    catch (error) { if (args[1] === "build") buildUnconfirmed = true; throw error; }
  };
  const directory = await mkdtemp(join(tmpdir(), "fleur-read-build-"));
  const owner = randomUUID(), tag = `fleur-read-build-${owner}`;
  const expected = new Map<string, string>();
  let disposed = false, journaled = false;
  const record = async (stage: "controller" | "worker" | "complete") => {
    if (!development) return;
    await development.record({ owner, endpoint, directory, stage, controller: expected.get("controller") ?? null, worker: expected.get("worker") ?? null });
    journaled = true;
  };
  const dispose = async () => {
    if (disposed) return;
    for (const role of ["worker", "controller"]) {
      const reference = tag+"-"+role;
      const lookup = () => command(["docker", "image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${reference}`]);
      const found = await lookup();
      if (!found) continue;
      if (!/^sha256:[a-f0-9]{64}$/.test(found)) throw new Error("IMAGE_OWNERSHIP_UNCONFIRMED");
      const metadata = JSON.parse(await command(["docker", "image", "inspect", reference, "--format", "{{json .}}"]));
      if (metadata.Id !== found || (expected.has(role) && expected.get(role) !== found)
        || metadata.Config?.Labels?.["dev.fleur.read-image-owner"] !== owner || !metadata.RepoTags?.includes(reference+":latest")) throw new Error("IMAGE_OWNERSHIP_UNCONFIRMED");
      if (await command(["docker", "ps", "--all", "--quiet", "--filter", `ancestor=${found}`])) throw new Error("IMAGE_IN_USE");
      await command(["docker", "image", "rm", reference]);
      if (await lookup()) throw new Error("IMAGE_CLEANUP_UNCONFIRMED");
    }
    if (journaled) await development?.release(owner);
    disposed = true;
  };
  try {
    await cp(fileURLToPath(new URL("./", import.meta.url)), join(directory, "native"), { recursive: true, filter: source => !source.includes("__pycache__") });
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("bootstrap.ts", import.meta.url))], target: "bun", minify: { whitespace: true } }); // Whitespace minification also drops module-path comments.
    if (!build.success || build.outputs.length !== 1) throw new Error("Trusted bootstrap build failed");
    await writeFile(join(directory, "bootstrap.js"), await build.outputs[0]!.text());
    await writeFile(join(directory, "application.js"), application);
    const architecture = await command(["docker", "info", "--format", "{{.Architecture}}"]);
    const arm = architecture === "aarch64" || architecture === "arm64";
    if (!arm && architecture !== "x86_64" && architecture !== "amd64") throw new Error("Unsupported native architecture");
    const compiler = arm ? "aarch64-linux-gnu-gcc-13" : "x86_64-linux-gnu-gcc-13";
    const compilerHash = arm ? "a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d" : "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26";
    const bases = nativeBaseImages[arm ? "arm64" : "x64"];
    await writeFile(join(directory, "Dockerfile"), `FROM ${bases.controller} AS controller
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install --yes --no-install-recommends python3 docker.io gcc-13=13.3.0-6ubuntu2~24.04.1 libc6-dev && rm -rf /var/lib/apt/lists/*
RUN echo '${compilerHash}  /usr/bin/${compiler}' | sha256sum --check
COPY native/ /controller/
RUN /usr/bin/${compiler} -shared -fPIC -O2 -std=c11 -Wall -Wextra -Werror -pthread /controller/transport.c -o /controller/filter.so
${lifecycleLabel}LABEL dev.fleur.read-image-owner=${owner}
ENTRYPOINT ["/usr/bin/python3", "-I", "-u", "/controller/controller.py"]
FROM ${bases.worker} AS worker
WORKDIR /probe
COPY --from=controller /controller/filter.so ./
COPY --chmod=0444 bootstrap.js application.js ./
ENV GLIBC_TUNABLES=glibc.pthread.rseq=0 BUN_JSC_useConcurrentJIT=0 BUN_JSC_useConcurrentGC=0 BUN_JSC_numberOfGCMarkers=1 BUN_JSC_useWarmUpMarkedBlocks=0
USER 65534:65534
${lifecycleLabel}LABEL dev.fleur.read-image-owner=${owner}
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
`);
    await record("controller");
    await command(["docker", "build", "--quiet", "--target", "controller", "-t", tag+"-controller", directory]);
    const controller = await command(["docker", "image", "inspect", tag+"-controller", "--format", "{{.Id}}"]);
    expected.set("controller", controller);
    await record("worker");
    await command(["docker", "build", "--quiet", "--target", "worker", "-t", tag+"-worker", directory]);
    const worker = await command(["docker", "image", "inspect", tag+"-worker", "--format", "{{.Id}}"]);
    expected.set("worker", worker);
    await record("complete");
    return { worker, controller, endpoint, dispose };
  } catch (error) {
    if (development && buildUnconfirmed) throw new Error("IMAGE_RECOVERY_REQUIRED", { cause: error });
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Image preparation and cleanup failed"); }
    throw error;
  } finally {
    // A timed-out build client cannot prove the daemon retired its request. Lifecycle recovery retains this intent.
    if (!development || !buildUnconfirmed) await rm(directory, { recursive: true, force: true });
  }
}
