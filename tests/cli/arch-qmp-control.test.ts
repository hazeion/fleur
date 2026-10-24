import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainInterruptionQmp } from "../../scripts/verify-debian-recovery.ts";

async function fixture(kvm: unknown, action: (path: string, commands: string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "fq-")); const path = join(root, "q.sock");
  const sockets = new Set<Socket>(); const commands: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + "\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString(); let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const query = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); commands.push(query.execute);
        const value = query.execute === "query-name" ? { name: "fleur-test" } : query.execute === "query-status" ? { running: true, status: "running" } : query.execute === "query-block" ? [{ inserted: { file: "/owned/overlay.qcow2", drv: "qcow2", ro: false } }] : query.execute === "query-kvm" ? kvm : {};
        socket.write(JSON.stringify({ id: query.id, return: value }) + "\n");
      }
    });
  });
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
    await action(path, commands);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}

test("Arch QMP requires actual enabled and present KVM while retaining the same VM/overlay witness", async () => {
  for (const state of [{ present: true, enabled: true }, { present: true, enabled: false }, { present: false, enabled: true }, { present: true, enabled: 1 }]) {
    await fixture(state, async (path, commands) => {
      const control = await retainInterruptionQmp(path, "fleur-test", performance.now() + 3000, new AbortController().signal, true);
      try {
        if (state.enabled === true && state.present === true) expect(await control.inspect("/owned/overlay.qcow2")).toEqual({ sameName: true, running: true, sameOverlay: true, kvmEnabled: true });
        else await expect(control.inspect("/owned/overlay.qcow2")).rejects.toThrow("KVM execution is unconfirmed");
        expect(commands).toContain("query-kvm");
      } finally { control.close(); }
    });
  }
});

test("legacy QMP default keeps its original three-field reply and cancellation retires continuity", async () => {
  await fixture({ present: false, enabled: false }, async (path, commands) => {
    const abort = new AbortController(); const control = await retainInterruptionQmp(path, "fleur-test", performance.now() + 3000, abort.signal);
    try {
      expect(await control.inspect("/owned/overlay.qcow2")).toEqual({ sameName: true, running: true, sameOverlay: true });
      expect(commands).not.toContain("query-kvm");
      abort.abort(); expect(control.alive()).toBe(false);
      await expect(control.inspect("/owned/overlay.qcow2")).rejects.toThrow();
    } finally { control.close(); }
  });
});
