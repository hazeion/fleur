import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "fleur-observer-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const observer = resolve(import.meta.dir, "../../scripts/proof-build-observer.ts");
const secret = "proof-private-canary-684db";
await writeFile(join(root, "docker"), `#!/bin/sh\nprintf '${secret}'\nprintf '${secret}' >&2\nexit 7\n`, { mode: 0o700 });
const fixture = join(root, "fixture.ts");
await writeFile(fixture, `const child = Bun.spawn([${JSON.stringify(join(root, "docker"))}, "save", ${JSON.stringify(secret)}], {stdout:"pipe",stderr:"pipe"}); const [out,err,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]); console.log(JSON.stringify({out,err,exit})); process.exit(Number(process.argv[2]));`);
async function run(exit: number) {
  const child = Bun.spawn([process.execPath, "--preload", observer, fixture, String(exit)], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, PRIVATE_CANARY: secret } });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: JSON.parse(out), error, code };
}
test("failed proof preserves tool streams and status but emits only fixed build stages", async () => {
  const result = await run(1);
  expect(result.code).toBe(1);
  expect(result.out).toEqual({ out: secret, err: secret, exit: 7 });
  expect(result.error).toBe('[fleur-proof-build] [{"stage":"docker-save","exit":7}]\n');
  expect(result.error).not.toContain(root);
  expect(result.error).not.toContain(secret);
});
test("successful proof adds no diagnostic output", async () => {
  const result = await run(0);
  expect(result.code).toBe(0);
  expect(result.error).toBe("");
  expect(result.out).toEqual({ out: secret, err: secret, exit: 7 });
});
test("failure diagnostics stay bounded across many child operations", async () => {
  const fixture = join(root, "bounded.ts");
  await writeFile(fixture, `await Promise.all(Array.from({length:70},async()=>{ const child=Bun.spawn([${JSON.stringify(join(root, "docker"))},"save"],{stdout:"ignore",stderr:"ignore"}); await child.exited; })); process.exit(1);`);
  const child = Bun.spawn([process.execPath, "--preload", observer, fixture], { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(out).toBe("");
  const observations = JSON.parse(error.slice("[fleur-proof-build] ".length));
  expect(observations).toHaveLength(64);
  expect(observations.every((value: unknown) => JSON.stringify(value) === '{"stage":"docker-save","exit":7}')).toBe(true);
});
