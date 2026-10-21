import { expect, test } from "bun:test";
import { collectUnixSocketSnapshot, type UnixDiagnosticTransport } from "../../src/setup/unix-diag.ts";
import { diagnosticDone, diagnosticRecord, kernelTape } from "./fixtures/unix-diag.ts";

async function collect(datagrams: readonly Buffer[], alter?: (received: ReturnType<ReturnType<typeof kernelTape>["receive"]>) => ReturnType<UnixDiagnosticTransport["receive"]>, timeout = 100) {
  const channel = kernelTape(datagrams);
  const result = await collectUnixSocketSnapshot(async () => ({ ...channel, receive: () => alter ? alter(channel.receive()) : channel.receive() }), timeout);
  expect(channel.closed).toBe(1);
  return result;
}
test("external Unix datagrams preserve inode-before-device VFS and socket identity separately", async () => {
  const result = await collect([diagnosticRecord("/run/test.sock", 1234, 0x12345678), diagnosticDone()]);
  expect(result).toEqual({ state: "complete", records: [{ name: "/run/test.sock", socketType: 1, state: 10, socketInode: 3003, cookie: [90, 91], vfs: { inode: 1234, device: 0x12345678 } }] });
});
for (const mode of ["short-header", "short-length", "long-length", "interrupted", "filtered", "request-flag", "not-multipart", "wrong-family", "attribute-short", "attribute-long", "invalid-name", "embedded-nul", "duplicate-name", "duplicate-vfs", "ack", "error", "overrun", "done-error", "data-after-done", "duplicate-record"] as const) test(`external ${mode} framing cannot become a complete kernel snapshot`, async () => {
  let frame = diagnosticRecord("/run/test.sock");
  if (mode === "short-header") frame = frame.subarray(0, 7);
  if (mode === "short-length") frame.writeUInt32LE(12);
  if (mode === "long-length") frame.writeUInt32LE(frame.length + 4);
  if (mode === "interrupted") frame.writeUInt16LE(0x12, 6);
  if (mode === "filtered") frame.writeUInt16LE(0x22, 6);
  if (mode === "request-flag") frame.writeUInt16LE(3, 6);
  if (mode === "not-multipart") frame.writeUInt16LE(0, 6);
  if (mode === "wrong-family") frame[16] = 2;
  if (mode === "attribute-short") frame.writeUInt16LE(3, 32);
  if (mode === "attribute-long") frame.writeUInt16LE(65535, 32);
  if (mode === "invalid-name") frame[36] = 255;
  if (mode === "embedded-nul") frame[38] = 0;
  if (mode === "duplicate-name" || mode === "duplicate-vfs") {
    const repeated = mode === "duplicate-name" ? frame.subarray(32, 32 + Math.ceil(frame.readUInt16LE(32) / 4) * 4) : frame.subarray(frame.length - 12);
    frame = Buffer.concat([frame, repeated]); frame.writeUInt32LE(frame.length);
  }
  if (mode === "ack" || mode === "error" || mode === "overrun" || mode === "done-error") {
    frame = diagnosticDone(); frame.writeUInt16LE(mode === "overrun" ? 4 : mode === "done-error" ? 3 : 2, 4);
    if (mode === "error" || mode === "done-error") frame.writeInt32LE(-1, 16);
  }
  const packets = mode === "data-after-done" ? [Buffer.concat([diagnosticDone(), frame])] : mode === "duplicate-record" ? [frame, frame, diagnosticDone()] : [frame, diagnosticDone()];
  expect(await collect(packets)).toEqual({ state: "unavailable" });
});
for (const mode of ["sender-port", "sender-groups", "sender-family", "sequence", "header-port", "truncation", "receive-error"] as const) test(`external ${mode} cannot be accepted as kernel evidence`, async () => {
  expect(await collect([diagnosticRecord("/run/test.sock"), diagnosticDone()], (result) => {
    if (result.state !== "datagram") return result;
    if (mode === "receive-error") return { state: "error" };
    if (mode === "sequence") result.data.writeUInt32LE(0, 8);
    if (mode === "header-port") result.data.writeUInt32LE(0, 12);
    return { ...result, ...(mode === "sender-port" ? { port: 1 } : {}), ...(mode === "sender-groups" ? { groups: 1 } : {}), ...(mode === "sender-family" ? { family: 1 } : {}), ...(mode === "truncation" ? { truncated: true } : {}) };
  })).toEqual({ state: "unavailable" });
});
test("missing DONE and repeated EAGAIN respect the existing deadline and close once", async () => {
  const start = performance.now();
  expect(await collect([diagnosticRecord("/run/test.sock")], undefined, 8)).toEqual({ state: "unavailable" });
  expect(performance.now() - start).toBeLessThan(500);
});
test("interrupted and temporarily unavailable receives may complete within the same deadline", async () => {
  const channel = kernelTape([diagnosticDone()]); let reads = 0;
  expect(await collectUnixSocketSnapshot(async () => ({ ...channel, receive: () => ++reads === 1 ? { state: "interrupted" } : reads === 2 ? { state: "again" } : channel.receive() }), 100)).toEqual({ state: "complete", records: [] });
  expect(channel.closed).toBe(1);
});
test("an incomplete send closes its owned channel and never reads a dump", async () => {
  const channel = kernelTape([]); let reads = 0;
  expect(await collectUnixSocketSnapshot(async () => ({ ...channel, send: () => 39, receive: () => { reads++; return channel.receive(); } }), 100)).toEqual({ state: "unavailable" });
  expect(reads).toBe(0); expect(channel.closed).toBe(1);
});
test("an exhausted caller budget never opens a native channel", async () => {
  let opened = 0;
  expect(await collectUnixSocketSnapshot(async () => { opened++; return kernelTape([]); }, 0)).toEqual({ state: "unavailable" });
  expect(opened).toBe(0);
});
test("the datagram bound rejects overlarge input before decoding", async () => {
  expect(await collect([Buffer.alloc(65537)])).toEqual({ state: "unavailable" });
});
test("the record bound rejects a complete-looking dump exceeding 4096 sockets", async () => {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < 4097; offset += 128) packets.push(Buffer.concat(Array.from({ length: Math.min(128, 4097 - offset) }, (_, index) => diagnosticRecord("/run/test.sock", 1234, 7, offset + index))));
  packets.push(diagnosticDone());
  expect(await collect(packets, undefined, 1000)).toEqual({ state: "unavailable" });
});
test("total wire bytes stay bounded even when large attributes carry no usable names", async () => {
  const packets = Array.from({ length: 17 }, (_, index) => {
    const record = Buffer.alloc(65536); record.writeUInt32LE(record.length); record.writeUInt16LE(20, 4); record.writeUInt16LE(2, 6); record[16] = 1; record[17] = 1; record[18] = 10; record.writeUInt32LE(index, 24); record.writeUInt16LE(65504, 32); record.writeUInt16LE(99, 34); return record;
  });
  expect(await collect(packets, undefined, 1000)).toEqual({ state: "unavailable" });
});
