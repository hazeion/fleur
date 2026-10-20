import { readFile } from "node:fs/promises";
import { expect } from "bun:test";

// Synthetic Linux UAPI records. Private native tapes may be supplied only to tests.
function message(kind: number, payload: Buffer, flags = 2): Buffer {
  const bytes = Buffer.alloc(16 + payload.length); bytes.writeUInt32LE(bytes.length); bytes.writeUInt16LE(kind, 4); bytes.writeUInt16LE(flags, 6); payload.copy(bytes, 16); return bytes;
}
function attribute(kind: number, payload: Buffer): Buffer {
  const bytes = Buffer.alloc((4 + payload.length + 3) & ~3); bytes.writeUInt16LE(4 + payload.length); bytes.writeUInt16LE(kind, 2); payload.copy(bytes, 4); return bytes;
}
export function diagnosticRecord(name: string, inode = 2002, device = 7, cookie = 90, socketType = 1, state = 10): Buffer {
  const header = Buffer.alloc(16); header[0] = 1; header[1] = socketType; header[2] = state; header.writeUInt32LE(3003, 4); header.writeUInt32LE(cookie, 8); header.writeUInt32LE(91, 12);
  const vfs = Buffer.alloc(8); vfs.writeUInt32LE(inode); vfs.writeUInt32LE(device, 4);
  return message(20, Buffer.concat([header, attribute(0, Buffer.from(name + "\0")), attribute(1, vfs)]));
}
export const diagnosticDone = () => message(3, Buffer.alloc(4));
export async function diagnosticTape() {
  if (process.env.FLEUR_TEST_DIAG_TAPE) {
    const value = JSON.parse(await readFile(process.env.FLEUR_TEST_DIAG_TAPE, "utf8"));
    return { datagrams: value.datagrams.map((item: { base64: string }) => Buffer.from(item.base64, "base64")) as Buffer[], selected: `${value.selectedBefore[0].dev}|${value.selectedBefore[0].inode}`, path: "/run/lvm/lvmpolld.socket" };
  }
  return { datagrams: [diagnosticRecord("/run/guarded/service.sock"), diagnosticDone()], selected: "7|1001", path: "/run/guarded/service.sock" };
}
export function kernelTape(datagrams: readonly Buffer[]) {
  let sequence = 0; let index = 0; let closed = 0;
  const port = 4100;
  return {
    get closed() { return closed; }, port,
    send(request: Uint8Array) {
      const data = Buffer.from(request);
      expect(data.length).toBe(40); expect(data.readUInt16LE(4)).toBe(20); expect(data.readUInt16LE(6)).toBe(0x301);
      expect(data[16]).toBe(1); expect(data.readUInt32LE(20)).toBe(0xffffffff); expect(data.readUInt32LE(28)).toBe(3);
      sequence = data.readUInt32LE(8); return data.length;
    },
    receive() {
      if (index >= datagrams.length) return { state: "again" as const };
      const data = Buffer.from(datagrams[index++]!);
      // The external kernel echoes the fresh request correlation fields.
      for (let offset = 0; offset + 16 <= data.length;) {
        const length = data.readUInt32LE(offset); data.writeUInt32LE(sequence, offset + 8); data.writeUInt32LE(port, offset + 12);
        if (length < 16) break; offset += (length + 3) & ~3;
      }
      return { state: "datagram" as const, data, family: 16, port: 0, groups: 0, truncated: false };
    },
    close() { closed++; },
  };
}
