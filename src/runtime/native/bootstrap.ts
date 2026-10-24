import { dlopen, FFIType, ptr } from "bun:ffi";
import { h } from "preact";
import render from "preact-render-to-string";
import { verifyRetainedHeap } from "./heap-probe";

const native = dlopen("/probe/filter.so", {
  prepare: { returns: FFIType.i32 }, install: { returns: FFIType.i32 },
  event_prepare: { returns: FFIType.i32 }, close_unrelated: { returns: FFIType.i32 },
  descriptors_closed: { returns: FFIType.i32 }, event_audit_ack: { returns: FFIType.i32 },
  event_inventory_count: { returns: FFIType.i32 },
  event_inventory_fd: { args: [FFIType.i32], returns: FFIType.i32 },
  event_inventory_kind: { args: [FFIType.i32], returns: FFIType.i32 },
  event_probe: { returns: FFIType.i32 }, event_negative: { args: [FFIType.i32], returns: FFIType.i32 },
  negative: { args: [FFIType.i32], returns: FFIType.i32 }, check_thread: { returns: FFIType.i32 },
  frame_receive: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  frame_exchange: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  frame_finish: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
}).symbols;
const source = await Bun.file("/probe/application.js").text();
if (source.length > 16 * 1024 * 1024) process.exit(10);
if ((await Bun.file("/sys/fs/cgroup/cpu.max").text()).trim() !== "100000 100000"
  || (await Bun.file("/sys/fs/cgroup/memory.max").text()).trim() !== "536870912"
  || (await Bun.file("/sys/fs/cgroup/pids.max").text()).trim() !== "64") process.exit(11);
if (render(h("p", null, "warmup")) !== "<p>warmup</p>") process.exit(12);
verifyRetainedHeap();
// No application module has been evaluated or compiled at this point.
if (native.prepare() !== 0 || native.event_prepare() !== 0 || native.close_unrelated() !== 0
  || native.descriptors_closed() !== 1 || native.install() !== 0) process.exit(13);
const count = native.event_inventory_count();
if (count < 2 || count > 192) process.exit(14);
const kinds = ["eventfd", "eventpoll", "timerfd"];
const inventory = Array.from({ length: count }, (_, i) => ({ fd: native.event_inventory_fd(i), kind: kinds[native.event_inventory_kind(i) - 1] }));
console.log(JSON.stringify({ kind: "startup-audit", inventory }));
if (native.event_audit_ack() !== 0) process.exit(15);
if (native.event_probe() !== 0 || Array.from({ length: 12 }, (_, i) => native.event_negative(i)).some(result => result !== -1)
  || Array.from({ length: 24 }, (_, i) => native.negative(i)).some(result => result !== -1)
  || native.check_thread() !== -1 || !verifyRetainedHeap().passed) process.exit(16);

const capacity = 2 * 1024 * 1024;
const receive = new Uint8Array(capacity);
const decode = (length: number): unknown => {
  if (length <= 0 || length > capacity) throw new Error("REQUEST_DENIED");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receive.subarray(0, length)));
};
const command = decode(native.frame_receive(ptr(receive), capacity));
let pending = false;
let checkedHeap = false;
const exchange = (request: unknown): unknown => {
  if (pending) throw new Error("REQUEST_DENIED");
  pending = true;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    if (!bytes.length || bytes.length > capacity) throw new Error("RESULT_TOO_LARGE");
    // Keep both typed arrays strongly reachable while the native call holds pointers.
    const result = decode(native.frame_exchange(ptr(bytes), bytes.length, ptr(receive), receive.length));
    if (!checkedHeap) { if (!verifyRetainedHeap().passed) throw new Error("INTERNAL_FAILURE"); checkedHeap = true; }
    return result;
  } finally { pending = false; }
};
let result: unknown;
try {
  const module = { exports: {} as { run?: (command: unknown, exchange: (request: unknown) => unknown) => Promise<unknown> } };
  new Function("module", "exports", source)(module, module.exports);
  if (typeof module.exports.run !== "function") throw new Error("SOURCE_REJECTED");
  result = await module.exports.run(command, exchange);
} catch { result = { kind: "failure", code: "INTERNAL_FAILURE" }; }
const frame = new TextEncoder().encode(JSON.stringify(result));
Object.defineProperty(globalThis, "__fleurCompletionFrame", { value: frame, writable: false, configurable: false });
native.frame_finish(ptr(frame), frame.length);
