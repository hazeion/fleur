import { endianness } from "node:os";
import { collectUnixSocketSnapshot, type UnixDiagnosticTransport, type UnixSocketSnapshot } from "./unix-diag.ts";
/** Linux-only libc ABI; loaded lazily after an admitted passive EACCES. */
export async function unixSocketSnapshot(timeoutMs: number): Promise<UnixSocketSnapshot> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || endianness() !== "LE") return { state: "unavailable" };
  return collectUnixSocketSnapshot(async (): Promise<UnixDiagnosticTransport> => {
    const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
    const library = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      sendto: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64_fast },
      recvfrom: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64_fast },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    let fd = -1; let closed = false;
    const close = () => { if (!closed) { closed = true; try { if (fd >= 0 && library.symbols.close(fd) !== 0) throw new Error("Diagnostic close unconfirmed"); } finally { library.close(); } } };
    try {
      fd = library.symbols.socket(16, 3 | 0x800 | 0x80000, 4);
      if (fd < 0) throw new Error("Diagnostic socket unavailable");
      const address = Buffer.alloc(12); address.writeUInt16LE(16); const size = new Uint32Array([12]);
      if (library.symbols.bind(fd, ptr(address), 12) !== 0 || library.symbols.getsockname(fd, ptr(address), ptr(size)) !== 0 || size[0] !== 12 || address.readUInt16LE(0) !== 16 || address.readUInt32LE(8) !== 0) throw new Error("Diagnostic binding unavailable");
      const port = address.readUInt32LE(4); const kernel = Buffer.alloc(12); kernel.writeUInt16LE(16);
      const buffer = Buffer.alloc(65536); const sender = Buffer.alloc(12); const senderSize = new Uint32Array([12]);
      return {
        port,
        send(request) { return Number(library.symbols.sendto(fd, ptr(request), request.byteLength, 0x40, ptr(kernel), 12)); },
        receive() {
          sender.fill(0); senderSize[0] = 12;
          const length = Number(library.symbols.recvfrom(fd, ptr(buffer), buffer.length, 0x40 | 0x20, ptr(sender), ptr(senderSize)));
          if (length < 0) {
            const location = library.symbols.__errno_location(); const error = location === null ? 0 : read.i32(location);
            return { state: error === 11 ? "again" : error === 4 ? "interrupted" : "error" };
          }
          if (senderSize[0] !== 12) return { state: "error" };
          return { state: "datagram", data: buffer.subarray(0, Math.min(length, buffer.length)), family: sender.readUInt16LE(0), port: sender.readUInt32LE(4), groups: sender.readUInt32LE(8), truncated: length > buffer.length };
        },
        close,
      };
    } catch (error) { close(); throw error; }
  }, timeoutMs);
}
