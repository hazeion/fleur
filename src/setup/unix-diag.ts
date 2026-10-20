import { endianness } from "node:os";
export interface UnixSocketRecord {
  readonly name?: string;
  readonly socketType: number;
  readonly state: number;
  readonly socketInode: number;
  readonly cookie: readonly [number, number];
  readonly vfs?: { readonly inode: number; readonly device: number };
}
export type UnixSocketSnapshot = { readonly state: "complete"; readonly records: readonly UnixSocketRecord[] } | { readonly state: "unavailable" };
/** External OS datagram boundary; callers cannot choose the diagnostic request. */
export interface UnixDiagnosticTransport {
  readonly port: number;
  send(request: Uint8Array): number;
  receive(): { readonly state: "again" | "interrupted" | "error" } | { readonly state: "datagram"; readonly data: Uint8Array; readonly family: number; readonly port: number; readonly groups: number; readonly truncated: boolean };
  close(): void;
}
/** One bounded, complete kernel dump. No raw evidence escapes through CLI results. */
export async function collectUnixSocketSnapshot(open: () => Promise<UnixDiagnosticTransport>, timeoutMs: number): Promise<UnixSocketSnapshot> {
  let transport: UnixDiagnosticTransport | undefined;
  let outcome: UnixSocketSnapshot = { state: "unavailable" };
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid diagnostic budget");
    const deadline = performance.now() + Math.min(3000, timeoutMs);
    const checkTime = () => { if (performance.now() >= deadline) throw new Error("Diagnostic deadline"); };
    const little = endianness() === "LE";
    transport = await open(); checkTime();
    if (!Number.isInteger(transport.port) || transport.port <= 0 || transport.port > 0xffffffff) throw new Error("Invalid diagnostic port");
    const sequence = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    const request = new Uint8Array(40); const wire = new DataView(request.buffer);
    wire.setUint32(0, 40, little); wire.setUint16(4, 20, little); wire.setUint16(6, 0x301, little);
    wire.setUint32(8, sequence, little); wire.setUint32(12, transport.port, little); wire.setUint8(16, 1);
    wire.setUint32(20, 0xffffffff, little); wire.setUint32(28, 3, little); wire.setUint32(32, 0xffffffff, little); wire.setUint32(36, 0xffffffff, little);
    if (transport.send(request) !== 40) throw new Error("Incomplete diagnostic send");
    const records: UnixSocketRecord[] = []; const seen = new Set<string>(); let total = 0; let done = false;
    while (!done) {
      checkTime(); const received = transport.receive();
      if (received.state === "again" || received.state === "interrupted") { await Bun.sleep(Math.min(2, Math.max(0, deadline - performance.now()))); continue; }
      if (received.state !== "datagram" || received.family !== 16 || received.port !== 0 || received.groups !== 0 || received.truncated) throw new Error("Unavailable diagnostic datagram");
      const bytes = received.data; total += bytes.byteLength;
      if (!bytes.byteLength || bytes.byteLength > 65536 || total > 1048576) throw new Error("Diagnostic byte bound");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset < bytes.length;) {
        checkTime();
        if (done || bytes.length - offset < 16) throw new Error("Invalid diagnostic framing");
        const length = view.getUint32(offset, little); const kind = view.getUint16(offset + 4, little); const flags = view.getUint16(offset + 6, little);
        const padded = Math.ceil(length / 4) * 4;
        if (length < 16 || offset + padded > bytes.length || view.getUint32(offset + 8, little) !== sequence || view.getUint32(offset + 12, little) !== transport.port || (flags & ~2)) throw new Error("Invalid diagnostic header");
        const start = offset + 16; const end = offset + length;
        if (kind === 3) {
          if ((end - start !== 0 && end - start !== 4) || (end - start === 4 && view.getInt32(start, little) !== 0)) throw new Error("Diagnostic DONE error");
          done = true;
        } else if (kind === 20) {
          if (!(flags & 2) || end - start < 16 || records.length >= 4096 || view.getUint8(start) !== 1 || view.getUint8(start + 3) !== 0) throw new Error("Invalid Unix diagnostic record");
          const socketType = view.getUint8(start + 1); const socketInode = view.getUint32(start + 4, little);
          const cookie = [view.getUint32(start + 8, little), view.getUint32(start + 12, little)] as const;
          const identity = `${socketInode}|${cookie[0]}|${cookie[1]}`;
          if (seen.has(identity)) throw new Error("Duplicate diagnostic identity"); seen.add(identity);
          let name: string | undefined; let vfs: UnixSocketRecord["vfs"]; const attributes = new Set<number>();
          for (let cursor = start + 16; cursor < end;) {
            checkTime();
            if (end - cursor < 4) throw new Error("Short diagnostic attribute");
            const size = view.getUint16(cursor, little); const type = view.getUint16(cursor + 2, little); const aligned = Math.ceil(size / 4) * 4;
            if (size < 4 || cursor + aligned > end || (type & 0xc000)) throw new Error("Invalid diagnostic attribute");
            if (type === 0 || type === 1) { if (attributes.has(type)) throw new Error("Duplicate diagnostic attribute"); attributes.add(type); }
            if (type === 0) {
              let data = bytes.subarray(cursor + 4, cursor + size);
              if (data.length > 4097) throw new Error("Diagnostic name bound");
              if (data[0] !== 0) {
                if (data.at(-1) === 0) data = data.subarray(0, -1);
                if (data.includes(0)) throw new Error("Invalid filesystem diagnostic name");
                name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
                if (!Buffer.from(name, "utf8").equals(data)) throw new Error("Nonidentical diagnostic name encoding");
              }
            } else if (type === 1) {
              if (size !== 12) throw new Error("Invalid diagnostic VFS");
              vfs = { inode: view.getUint32(cursor + 4, little), device: view.getUint32(cursor + 8, little) };
            }
            cursor += aligned;
          }
          records.push({ socketType, state: view.getUint8(start + 2), socketInode, cookie, ...(name !== undefined ? { name } : {}), ...(vfs ? { vfs } : {}) });
        } else throw new Error("Diagnostic error or unexpected message");
        offset += padded;
      }
    }
    checkTime(); outcome = { state: "complete", records };
  } catch { /* Incomplete evidence remains unavailable. */ }
  finally { if (transport) { try { transport.close(); } catch { outcome = { state: "unavailable" }; } } }
  return outcome;
}
