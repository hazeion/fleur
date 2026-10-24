import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { selectedEndpoint, type NativeImages } from "./endpoint";
import { nativeCommand } from "./command";

/** Explicit build-time acquisition; serving never installs packages or builds images. */
export async function prepareNativeImages(application: string): Promise<NativeImages> {
  const endpoint = await selectedEndpoint();
  const command = (args: string[]) => nativeCommand([args[0]!, "--host", endpoint, ...args.slice(1)], args[1] === "build" ? 300_000 : 5000);
  const directory = await mkdtemp(join(tmpdir(), "fleur-read-build-"));
  const tag = `fleur-read-build-${randomUUID()}`;
  try {
    await cp(fileURLToPath(new URL("./", import.meta.url)), join(directory, "native"), { recursive: true, filter: source => !source.includes("__pycache__") });
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("bootstrap.ts", import.meta.url))], target: "bun", minify: false });
    if (!build.success || build.outputs.length !== 1) throw new Error("Trusted bootstrap build failed");
    await writeFile(join(directory, "bootstrap.js"), await build.outputs[0]!.text());
    await writeFile(join(directory, "application.js"), application);
    const architecture = await command(["docker", "info", "--format", "{{.Architecture}}"]);
    const arm = architecture === "aarch64" || architecture === "arm64";
    if (!arm && architecture !== "x86_64" && architecture !== "amd64") throw new Error("Unsupported native architecture");
    const compiler = arm ? "aarch64-linux-gnu-gcc-13" : "x86_64-linux-gnu-gcc-13";
    const compilerHash = arm ? "a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d" : "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26";
    const base = arm ? "bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" : "c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
    await writeFile(join(directory, "Dockerfile"), `FROM ubuntu@sha256:a2d43bffc46670d7108bb3c0468c67c5557c4c92e83e1e34cbff1322ad1b94dc AS controller
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install --yes --no-install-recommends python3 docker.io gcc-13=13.3.0-6ubuntu2~24.04.1 libc6-dev && rm -rf /var/lib/apt/lists/*
RUN echo '${compilerHash}  /usr/bin/${compiler}' | sha256sum --check
COPY native/ /controller/
RUN /usr/bin/${compiler} -shared -fPIC -O2 -std=c11 -Wall -Wextra -Werror -pthread /controller/transport.c -o /controller/filter.so
ENTRYPOINT ["/usr/bin/python3", "-I", "-u", "/controller/controller.py"]
FROM oven/bun@sha256:${base} AS worker
WORKDIR /probe
COPY --from=controller /controller/filter.so ./
COPY bootstrap.js application.js ./
ENV GLIBC_TUNABLES=glibc.pthread.rseq=0 BUN_JSC_useConcurrentJIT=0 BUN_JSC_useConcurrentGC=0 BUN_JSC_numberOfGCMarkers=1 BUN_JSC_useWarmUpMarkedBlocks=0
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
`);
    await command(["docker", "build", "--quiet", "--target", "controller", "-t", tag+"-controller", directory]);
    await command(["docker", "build", "--quiet", "--target", "worker", "-t", tag+"-worker", directory]);
    const controller = await command(["docker", "image", "inspect", tag+"-controller", "--format", "{{.Id}}"]);
    const worker = await command(["docker", "image", "inspect", tag+"-worker", "--format", "{{.Id}}"]);
    return { worker, controller, endpoint };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
