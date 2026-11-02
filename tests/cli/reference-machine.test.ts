import { expect, test } from "bun:test";
import { linuxReferenceHardware, observeLinuxReferenceHardware } from "../../scripts/reference-machine";
const memory = { memory: [{ size: 16 * 1024 ** 3, state: "online" }] };
const blocks = { blockdevices: [{ "maj:min": "8:0", type: "disk", rota: false, children: [{ "maj:min": "8:1", type: "part", rota: false }] }] };
const mount = { filesystems: [{ "maj:min": "8:1" }] };
test("Linux reference uses online memory capacity and the workspace's nonrotating backing disk", () => {
  expect(linuxReferenceHardware(memory, blocks, mount)).toEqual({ memoryBytes: 16 * 1024 ** 3, device: "8:0" });
});
test("missing memory, offline capacity and less than sixteen GiB cannot qualify", () => {
  for (const value of [{}, { memory: [{ size: 16 * 1024 ** 3, state: "offline" }] }, { memory: [{ size: 16 * 1024 ** 3 - 1, state: "online" }] }, { memory: [{ size: -1, state: "online" }] }]) expect(() => linuxReferenceHardware(value, blocks, mount)).toThrow();
});
test("a rotating or unidentified backing disk cannot establish SSD storage", () => {
  const rotating = structuredClone(blocks); rotating.blockdevices[0]!.rota = true;
  for (const [devices, mounted] of [[rotating, mount], [blocks, { filesystems: [{ "maj:min": "0:42" }] }], [{}, mount], [blocks, {}]]) expect(() => linuxReferenceHardware(memory, devices, mounted)).toThrow();
});
test("string sizes and split online memory blocks retain exact capacity", () => {
  expect(linuxReferenceHardware({ memory: [{ size: String(8 * 1024 ** 3), state: "online" }, { size: String(8 * 1024 ** 3), state: "online" }] }, blocks, mount).memoryBytes).toBe(16 * 1024 ** 3);
});
test("the Linux observer requests disk ancestry instead of lsblk's flat JSON output", () => {
  const observe = (args: string[]) => {
    if (args[0] === "lsmem") return JSON.stringify(memory);
    if (args[0] === "findmnt") { expect(args).toContain("/owned/workspace"); return JSON.stringify(mount); }
    // lsblk emits children only when NAME is selected or --tree is explicit.
    return JSON.stringify(args.includes("--tree") ? blocks : { blockdevices: [blocks.blockdevices[0], blocks.blockdevices[0]!.children[0]].map(value => ({ ...value, children: undefined })) });
  };
  expect(observeLinuxReferenceHardware("/owned/workspace", observe, "8:1")).toEqual({ memoryBytes: 16 * 1024 ** 3, device: "8:0", databaseDevice: "8:0" });
});
test("an SSD checkout cannot qualify a database stored on a rotating disk", () => {
  const disks = structuredClone(blocks);
  disks.blockdevices.push({ "maj:min": "8:16", type: "disk", rota: true, children: [{ "maj:min": "8:17", type: "part", rota: true }] });
  const observe = (args: string[]) => JSON.stringify(args[0] === "lsmem" ? memory : args[0] === "findmnt" ? mount : disks);
  expect(() => observeLinuxReferenceHardware("/owned/workspace", observe, "8:17")).toThrow();
});
