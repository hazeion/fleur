import { expect, test } from "bun:test";
import { FrameReader } from "../../src/runtime/native/host";
function reader(chunks: Uint8Array[]) {
  return new FrameReader(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
}
function frame(bytes: Uint8Array) { const output = new Uint8Array(bytes.length+4); new DataView(output.buffer).setUint32(0, bytes.length); output.set(bytes, 4); return output; }
test("framing handles partial reads and rejects truncated, excessive, invalid UTF-8 and nonpublic data", async () => {
  const valid = frame(new TextEncoder().encode('{"kind":"complete","value":null}'));
  expect(await reader([...valid].map(byte => new Uint8Array([byte]))).read()).toEqual({ kind: "complete", value: null });
  await expect(reader([valid.slice(0,-1)]).read()).rejects.toThrow("TRANSPORT_EOF");
  const oversized = new Uint8Array(4); new DataView(oversized.buffer).setUint32(0, 2097153);
  await expect(reader([oversized]).read()).rejects.toThrow("FRAME_BOUND");
  await expect(reader([new Uint8Array(4)]).read()).rejects.toThrow("FRAME_BOUND");
  await expect(reader([frame(new Uint8Array([0xff]))]).read()).rejects.toThrow();
  await expect(reader([frame(new TextEncoder().encode('{"value":1e999}'))]).read()).rejects.toThrow();
});
