import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { z } from "zod";
import { observeGithubStorage } from "./github-reference-storage";

const device = z.string().regex(/^[0-9]{1,10}:[0-9]{1,10}$/);
interface Block { "maj:min": string; type: string; rota: boolean | 0 | 1 | null; children?: Block[] | undefined }
const block: z.ZodType<Block> = z.lazy(() => z.object({ "maj:min": device, type: z.string(), rota: z.union([z.boolean(), z.literal(0), z.literal(1), z.null()]), children: z.array(block).max(4096).optional() }));
/** Kernel online memory includes reserved RAM that MemTotal excludes. Never round capacity up. */
export function linuxReferenceHardware(memory: unknown, blocks: unknown, mount: unknown, provider?: { rootDisk: string }): { memoryBytes: number; device: string } {
  const size = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)]);
  const observed = z.object({ memory: z.array(z.object({ size, state: z.enum(["online", "offline"]) })).min(1).max(4096) }).parse(memory);
  const memoryBytes = observed.memory.filter(part => part.state === "online").reduce((sum, part) => sum + part.size, 0);
  assert.ok(Number.isSafeInteger(memoryBytes) && memoryBytes >= 16 * 1024 ** 3, "Reference machine needs at least 16 GiB online RAM");
  const disk = backingDisk(blocks, mount);
  assert.ok(disk.rota === false || disk.rota === 0 || provider?.rootDisk === disk["maj:min"], "Reference workspace requires observed nonrotating storage or bound provider SSD evidence");
  if (provider) assert.equal(disk["maj:min"], provider.rootDisk, "Provider evidence admits only the runner root disk");
  return { memoryBytes, device: disk["maj:min"] };
}
function backingDisk(blocks: unknown, mount: unknown): Block {
  const mounted = z.object({ filesystems: z.tuple([z.object({ "maj:min": device })]) }).parse(mount).filesystems[0]["maj:min"];
  const devices = z.object({ blockdevices: z.array(block).max(4096) }).parse(blocks).blockdevices;
  const contains = (value: Block): boolean => value["maj:min"] === mounted || Boolean(value.children?.some(contains));
  const disks: Block[] = [];
  const visit = (value: Block) => { if (value.type === "disk" && contains(value)) disks.push(value); for (const child of value.children ?? []) visit(child); };
  for (const value of devices) visit(value);
  assert.equal(disks.length, 1, "Reference workspace must identify one backing disk");
  return disks[0]!;
}
function command(args: string[]): string {
  const child = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore", timeout: 10000, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  assert.equal(child.exitCode, 0, "Reference hardware observation failed");
  assert.ok(child.stdout.byteLength <= 1024 * 1024, "Reference hardware observation exceeded its bound");
  return child.stdout.toString();
}
export function observeLinuxReferenceHardware(directory: string, observe: (args: string[]) => string, databaseDevice: string, provider?: { rootDisk: string }) {
  const memory = JSON.parse(observe(["lsmem", "--json", "--bytes", "--output", "SIZE,STATE"]));
  const blocks = JSON.parse(observe(["lsblk", "--json", "--tree", "--output", "MAJ:MIN,TYPE,ROTA"]));
  const workspace = linuxReferenceHardware(memory, blocks, JSON.parse(observe(["findmnt", "--json", "--target", directory, "--output", "MAJ:MIN"])), provider);
  const database = linuxReferenceHardware(memory, blocks, { filesystems: [{ "maj:min": device.parse(databaseDevice) }] }, provider);
  return { ...workspace, databaseDevice: database.device };
}
export async function referenceMachine(directory: string, databaseDevice: string, commit: string, sourceWorkflow: string) {
  const usableMemoryBytes = totalmem();
  if (process.platform === "darwin") {
    const storage = command(["diskutil", "info", "-plist", "/"]);
    assert.match(storage, /<key>SolidState<\/key>\s*<true\s*\/>/, "Reference machine requires observed SSD storage");
    return { ssd: true, version: command(["sw_vers", "-productVersion"]).trim(), memoryBytes: usableMemoryBytes, usableMemoryBytes, memoryEvidence: "os.totalmem", storageEvidence: "diskutil SolidState" };
  }
  assert.equal(process.platform, "linux", "Reference hardware observation supports macOS and Linux");
  let provider: Awaited<ReturnType<typeof observeGithubStorage>> | undefined;
  let rootDisk: string | undefined;
  const blocks = JSON.parse(command(["lsblk", "--json", "--tree", "--output", "MAJ:MIN,TYPE,ROTA"]));
  const mount = JSON.parse(command(["findmnt", "--json", "--target", directory, "--output", "MAJ:MIN"]));
  const workspaceDisk = backingDisk(blocks, mount);
  if (workspaceDisk.rota !== false && workspaceDisk.rota !== 0) {
    provider = await observeGithubStorage(commit, sourceWorkflow);
    rootDisk = backingDisk(blocks, JSON.parse(command(["findmnt", "--json", "--target", "/", "--output", "MAJ:MIN"])))["maj:min"];
  }
  const hardware = observeLinuxReferenceHardware(directory, args => args[0] === "lsblk" ? JSON.stringify(blocks) : command(args), databaseDevice, rootDisk ? { rootDisk } : undefined);
  const version = readFileSync("/etc/os-release", "utf8").split("\n").find(line => line.startsWith("PRETTY_NAME="))?.slice(12).replace(/^"(.*)"$/, "$1");
  assert.ok(version && version.length <= 128, "Reference OS version is unavailable");
  return { ssd: true, version, memoryBytes: hardware.memoryBytes, usableMemoryBytes, memoryEvidence: "lsmem online memory blocks", storageEvidence: { workspaceDisk: hardware.device, databaseDisk: hardware.databaseDevice, databaseVolumeDevice: databaseDevice, blockDevices: blocks, ...(provider ? { provider, rootDisk } : { nonrotating: true }) } };
}
