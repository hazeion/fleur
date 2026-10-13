import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { assertBrowserOnly } from "./artifact-check";

test("artifact verifier rejects server code and fake secrets in chunks or maps", () => {
  for (const name of ["client.js", "client.js.map"]) {
    for (const content of ["FLEUR_SERVER_SECRET_CANARY_23", "serverOnlyExerciseLookup", "server.tsx"]) {
      expect(() => assertBrowserOnly([{ name, content }])).toThrow();
    }
  }
});

test("production browser chunks and source maps exclude the server-only graph", async () => {
  const names = (await readdir("dist")).filter(name => /\.(js|map)$/.test(name));
  expect(names.some(name => name.endsWith(".js"))).toBe(true);
  expect(names.some(name => name.endsWith(".js.map"))).toBe(true);
  const files = await Promise.all(names.map(async name => ({ name, content: await readFile(`dist/${name}`, "utf8") })));
  assertBrowserOnly(files);
  for (const file of files.filter(file => file.name.endsWith(".map"))) {
    const map = JSON.parse(file.content);
    expect(map.sources.some((source: string) => source.endsWith("island.tsx"))).toBe(true);
    expect(map.sources.some((source: string) => source.endsWith("client.tsx"))).toBe(true);
    expect(map.sources.some((source: string) => source.endsWith("props.ts"))).toBe(true);
  }
});
