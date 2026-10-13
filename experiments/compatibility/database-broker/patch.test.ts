import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PgRelationalQuery } from "drizzle-orm/pg-core/query-builders/query";
import provenance from "./patches/provenance.json";

const packageRoot = dirname(Bun.resolveSync("drizzle-orm", import.meta.dir));
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

test("declaration repair retains the exact upstream source and runtime", () => {
  for (const file of provenance.files) {
    const sourceMap = readFileSync(join(packageRoot, file.file.replace(".d.ts", ".js.map")));
    const map = JSON.parse(sourceMap.toString());
    expect(sha256(sourceMap)).toBe(file.published_source_map_sha256);
    expect(sha256(map.sourcesContent[0])).toBe(file.source_sha256);
    expect(sha256(readFileSync(join(packageRoot, file.file)))).toBe(file.patched_declaration_sha256);
    expect(sha256(readFileSync(join(packageRoot, file.file.replace(".d.ts", ".js"))))).toBe(file.published_runtime_sha256);
  }
  expect(typeof PgRelationalQuery.prototype.getSQL).toBe("function");
});
