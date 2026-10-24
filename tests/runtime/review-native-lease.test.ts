import { expect, test } from "bun:test";

test("native lease stops creation authority before inspecting children and removes guard last", () => {
  // Isolate the mocked host module from the real native integration tests.
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    const owner = "00000000-0000-0000-0000-000000000000";
    const boot = "11111111-1111-1111-1111-111111111111";
    const images = { worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint: "unix:///var/run/docker.sock" };
    const names = {
      controller: "fleur-read-controller-" + owner,
      worker: "fleur-read-" + owner + "-worker",
      guard: "fleur-read-" + owner + "-guard",
    };
    const ids = { controller: "c".repeat(64), worker: "d".repeat(64), guard: "e".repeat(64) };
    const remaining = new Set(Object.keys(names));
    let managerRunning = true, guardRunning = true;
    const events = [];
    mock.module("./src/setup/host.ts", () => ({ productionHost: () => ({ run: async args => {
      if (args[1] !== "--host" || args[2] !== images.endpoint) throw new Error("lease endpoint drift");
      args = [args[0], ...args.slice(3)];
      const action = args[1];
      let output = "";
      if (action === "ps") {
        const role = Object.keys(names).find(role => args.at(-1) === "name=^/" + names[role] + "$");
        if (!role) throw new Error("unexpected name");
        if (role !== "controller" && managerRunning) throw new Error("child inspection while manager can create resources");
        events.push("inspect:" + role);
        output = remaining.has(role) ? ids[role] : "";
      } else if (action === "inspect") {
        const role = Object.keys(ids).find(role => ids[role] === args[2]);
        output = JSON.stringify({ Id: ids[role], Name: "/" + names[role], Image: role === "worker" ? images.worker : images.controller,
          State: { Running: role === "controller" ? managerRunning : role === "guard" ? guardRunning : false,
            Pid: role === "controller" && managerRunning ? 123 : role === "guard" && guardRunning ? 456 : 0 },
          Config: { Labels: { [role === "controller" ? "dev.fleur.read-controller-owner" : "fleur.compatibility.runtime-owner"]: role === "controller" ? owner : "fleur-read-" + owner },
            Entrypoint: ["/usr/bin/python3"], Cmd: ["-I", "-u", "/controller/guard.py", ids.worker, "123", "100.5", boot] } });
      } else if (action === "kill") {
        if (args.at(-1) !== ids.controller) throw new Error("only manager kill permitted");
        managerRunning = false; events.push("stop:controller");
      } else if (action === "wait") {
        guardRunning = false; events.push("wait:guard"); output = "0";
      } else if (action === "logs") {
        output = JSON.stringify({ kind: "armed" }) + "\\n" + JSON.stringify({ kind: "result", physical_exit_confirmed: true, outcome: "premature-exit", kill_lateness_ms: 0, physical_exit_lateness_ms: 0 });
      } else if (action === "rm") {
        const role = Object.keys(ids).find(role => ids[role] === args.at(-1));
        if (role === "guard" && remaining.has("worker")) throw new Error("guard removed before worker absence");
        remaining.delete(role); events.push("remove:" + role);
      } else throw new Error("unexpected command");
      return { status: "completed", exitCode: 0, stdout: output, stderr: "" };
    } }) }));
    const { NativeLease } = await import("./src/runtime/native/lease.ts");
    const lease = await NativeLease.create(owner, images);
    await lease.bindWorker({ id: ids.worker, pid: 123, boot });
    await lease.bindGuard({ id: ids.worker, pid: 123, boot, guard: ids.guard, deadline: 100.5 });
    const recovered = await NativeLease.recover(lease.recoveryDirectory);
    await recovered.cleanup();
    console.log(JSON.stringify({ events, remaining: [...remaining] }));
  `], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as { events: string[]; remaining: string[] };
  expect(result.remaining).toEqual([]);
  expect(result.events.indexOf("stop:controller")).toBeLessThan(result.events.indexOf("inspect:worker"));
  expect(result.events.indexOf("remove:worker")).toBeLessThan(result.events.indexOf("remove:guard"));
  expect(result.events.indexOf("remove:guard")).toBeLessThan(result.events.indexOf("remove:controller"));
});

test("an unobserved daemon create retains its journal across recovery instead of treating absence as retirement", () => {
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { readFile, rm } from "node:fs/promises";
    import { join } from "node:path";
    mock.module("./src/setup/host.ts", () => ({ productionHost: () => ({ run: async () => ({ status: "completed", exitCode: 0, stdout: "", stderr: "" }) }) }));
    const { NativeLease } = await import("./src/runtime/native/lease.ts");
    const lease = await NativeLease.create("00000000-0000-0000-0000-000000000000", { worker: "sha256:"+"a".repeat(64), controller: "sha256:"+"b".repeat(64), endpoint: "unix:///var/run/docker.sock" });
    try {
      await lease.beginCreation("worker");
      const journal = join(lease.recoveryDirectory, "lease.json");
      const before = await readFile(journal, "utf8");
      const recovered = await NativeLease.recover(lease.recoveryDirectory);
      let code;
      try { await recovered.cleanup(); } catch (error) { code = error.message; }
      console.log(JSON.stringify({ code, unchanged: before === await readFile(journal, "utf8") }));
    } finally { await rm(lease.recoveryDirectory, { recursive: true, force: true }); }
  `], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ code: "RECOVERY_REQUIRED", unchanged: true });
});
