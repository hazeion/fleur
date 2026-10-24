import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";

test("source admission follows transitive imports and refuses browser authority escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-admission-"));
  try {
    for (const part of ["client", "server", "shared"]) await mkdir(join(root, part));
    await writeFile(join(root, "server", "private.ts"), 'export const password = "chunk-secret-canary";');
    await writeFile(join(root, "shared", "public.ts"), 'export const label = "Exercises";');
    await writeFile(join(root, "client", "view.tsx"), 'import {label} from "../shared/public"; export const title = label;');
    expect((await admitProject(root)).client.length).toBe(1);
    for (const forbidden of [
      'export {password} from "../server/private";',
      'import type {Secret} from "../server/private"; export const title = "bad";',
      'import {SQL} from "bun";',
      'import {db} from "fleur/database";',
      'const path = "./hidden"; export const hidden = import(path);',
      'import "https://example.invalid/script.js";',
    ]) {
      await writeFile(join(root, "shared", "public.ts"), forbidden);
      await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("build resolution uses admitted bytes and cannot load an unapproved JSX runtime", async () => {
  const { compileClient } = await import("../../src/runtime/build/client");
  const { compileWorker } = await import("../../src/runtime/build/worker");
  const root = await mkdtemp(join(tmpdir(), "fleur-snapshot-"));
  try {
    await mkdir(join(root, "client"));
    const path = join(root, "client", "view.tsx");
    await writeFile(path, 'export const value = "admitted-source-snapshot";');
    const project = await admitProject(root);
    await writeFile(path, 'import "node:fs"; export const value = "changed-after-admission";');
    const worker = await compileWorker(project), client = await compileClient(project);
    expect(worker).toContain("admitted-source-snapshot");
    expect(worker).not.toContain("changed-after-admission");
    expect([...client.files.values()].map(file => String(file.body)).join(" ")).not.toContain("changed-after-admission");
    await writeFile(path, '/** @jsxImportSource unapproved-package */\nexport const view = <div/>;');
    const escaped = await admitProject(root);
    await expect(compileClient(escaped)).rejects.toThrow();
    await expect(compileWorker(escaped)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
