import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiler generic tools obey authenticated alias, search and rollback contracts", async () => {
  const python = Bun.which("python3");
  if (!python) throw new Error("Existing Python is required for compiler filesystem contracts");
  const root = await mkdtemp(join(tmpdir(), "fleur-binutils-fixture-"));
  try {
    const response = await fetch("https://archive.ubuntu.com/ubuntu/pool/main/b/binutils/binutils-x86-64-linux-gnu_2.42-4ubuntu2.10_amd64.deb", { signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error("Official frozen binutils fixture unavailable");
    const parts: Uint8Array[] = []; let size = 0;
    for await (const part of response.body) { size += part.byteLength; if (size > 2462744) throw new Error("Binutils fixture exceeds frozen bound"); parts.push(part); }
    const body = Buffer.concat(parts);
    if (body.length !== 2462744 || Bun.CryptoHasher.hash("sha256", body, "hex") !== "1e510a15f30208d39edcd840e48f26a77bbca7c417805eeccb1e3f7de198ef29" || body.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("Binutils fixture authentication failed");
    let data: Uint8Array | undefined;
    for (let offset = 8; offset + 60 <= body.length;) {
      const header = body.subarray(offset, offset + 60); const bytes = Number(header.subarray(48, 58).toString().trim());
      if (!Number.isSafeInteger(bytes) || bytes < 0 || offset + 60 + bytes > body.length) throw new Error("Malformed authenticated ar fixture");
      if (header.subarray(0, 16).toString().trim().replace(/\/$/, "") === "data.tar.zst") data = body.subarray(offset + 60, offset + 60 + bytes);
      offset += 60 + bytes + bytes % 2;
    }
    if (!data) throw new Error("Authenticated fixture lacks expected payload");
    const tar = Bun.zstdDecompressSync(data); if (tar.length > 32 * 1024 * 1024) throw new Error("Authenticated payload exceeds test bound");
    const archive = join(root, "payload.tar"); await writeFile(archive, tar, { flag: "wx", mode: 0o600 });
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/guest-compiler-binutils.py"), resolve(import.meta.dir, "../../scripts/prepare-guest-compiler.py"), archive], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stdout + stderr).toBe(0); expect(stderr).toContain("Ran 16 tests"); expect(stderr).toContain("OK");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90000);
