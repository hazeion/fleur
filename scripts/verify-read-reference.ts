import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const directory = join(root, "dist", "reference-check");
await mkdir(directory, { recursive: true });
try {
  const fixture = (await readFile(join(root, "tests/runtime/contracts.types.ts"), "utf8")).replaceAll("../../src/", "../reference/");
  await writeFile(join(directory, "contracts.ts"), fixture);
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { exactOptionalPropertyTypes: true }, include: ["contracts.ts"] }));
  const child = Bun.spawn([process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", join(directory, "tsconfig.json")], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Generated read reference failed its consumer fixtures");
} finally { await rm(directory, { recursive: true, force: true }); }
