import { expect, test } from "bun:test";

function scenario(mode: "normal" | "foreign" | "referenced" | "partial") {
  const result = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    const mode = ${JSON.stringify(mode)};
    const endpoint = "unix:///var/run/docker.sock";
    const images = new Map(), calls = [], removed = [];
    let block = true;
    mock.module("./src/runtime/native/endpoint.ts", () => ({ selectedEndpoint: async () => endpoint }));
    mock.module("./src/runtime/native/command.ts", () => ({ nativeCommand: async supplied => {
      const args = [...supplied];
      calls.push(args);
      if (args[0] !== "docker" || args[1] !== "--host" || args[2] !== endpoint) throw new Error("endpoint drift");
      args.splice(1, 2);
      if (args[1] === "info") return "x86_64";
      if (args[1] === "build") {
        const tag = args[args.indexOf("-t") + 1];
        if (mode === "partial" && tag.endsWith("-worker")) throw new Error("BUILD_REJECTED");
        const owner = tag.replace(/^fleur-read-build-/, "").replace(/-(controller|worker)$/, "");
        const dockerfile = await Bun.file(args.at(-1) + "/Dockerfile").text();
        const labelled = dockerfile.includes("LABEL dev.fleur.read-image-owner=" + owner);
        images.set(tag, { Id: "sha256:" + (tag.endsWith("-worker") ? "a" : "b").repeat(64), RepoTags: [tag + ":latest"],
          Config: { Labels: labelled ? { "dev.fleur.read-image-owner": owner } : {} } });
        return "";
      }
      if (args[1] === "image" && args[2] === "ls") {
        const reference = args.find(value => value.startsWith("reference="))?.slice(10);
        if (!reference) throw new Error("unscoped image enumeration");
        return images.get(reference)?.Id ?? "";
      }
      if (args[1] === "image" && args[2] === "inspect") {
        const metadata = images.get(args[3]) ?? [...images.values()].find(image => image.Id === args[3]);
        if (!metadata) throw new Error("IMAGE_ABSENT");
        if (args.at(-1) === "{{.Id}}") return metadata.Id;
        return JSON.stringify(mode === "foreign" && block ? { ...metadata, Config: { Labels: { "dev.fleur.read-image-owner": "another-owner" } } } : metadata);
      }
      if (args[1] === "ps") {
        if (!args.includes("--all") || !args.some(value => value.startsWith("ancestor=sha256:"))) throw new Error("unscoped container check");
        return mode === "referenced" && block ? "c".repeat(64) : "";
      }
      if (args[1] === "image" && args[2] === "rm") {
        if (args.length !== 4 || !images.has(args[3])) throw new Error("removal must name only an owned tag, without force");
        removed.push(args[3]); images.delete(args[3]); return "";
      }
      throw new Error("unexpected Docker operation: " + JSON.stringify(args));
    } }));
    const { prepareNativeImages } = await import("./src/runtime/native/build.ts");
    let prepared, failure;
    try { prepared = await prepareNativeImages("module.exports.run = async () => null;"); }
    catch (error) { failure = error.message; }
    if (mode === "partial") {
      console.log(JSON.stringify({ failure, removed, remaining: [...images.keys()], calls }));
    } else {
      if (typeof prepared?.dispose !== "function") throw new Error("IMAGE_DISPOSAL_MISSING");
      let refusal;
      try { await prepared.dispose(); } catch (error) { refusal = error.message; }
      const removedBeforeRetry = removed.length;
      block = false;
      process.env.DOCKER_HOST = "tcp://untrusted.invalid:2375";
      process.env.DOCKER_CONTEXT = "untrusted-context";
      await prepared.dispose();
      const callsAfterSuccess = calls.length;
      await prepared.dispose();
      console.log(JSON.stringify({ refusal, removedBeforeRetry, removed, remaining: [...images.keys()], calls,
        callsAfterSuccess, callsAfterRepeat: calls.length }));
    }
  `], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString()) as {
    failure?: string; refusal?: string; removedBeforeRetry: number; removed: string[];
    remaining: string[]; callsAfterSuccess: number; callsAfterRepeat: number;
  };
}

test("native image disposal removes its owned tags and repeated disposal has no effects", () => {
  const result = scenario("normal");
  expect(result.refusal).toBeUndefined();
  expect(result.removed).toHaveLength(2);
  expect(result.removed[0]).toEndWith("-worker");
  expect(result.removed[1]).toEndWith("-controller");
  expect(result.remaining).toEqual([]);
  expect(result.callsAfterRepeat).toBe(result.callsAfterSuccess);
});

for (const mode of ["foreign", "referenced"] as const) test(`native image disposal refuses ${mode} resources without removal and permits a verified retry`, () => {
  const result = scenario(mode);
  expect(result.refusal).toBeString();
  expect(result.removedBeforeRetry).toBe(0);
  expect(result.removed).toHaveLength(2);
  expect(result.remaining).toEqual([]);
});

test("partial native build failure retires the first stage's owned image tag", () => {
  const result = scenario("partial");
  expect(result.failure).toContain("BUILD_REJECTED");
  expect(result.removed).toHaveLength(1);
  expect(result.removed[0]).toEndWith("-controller");
  expect(result.remaining).toEqual([]);
});
