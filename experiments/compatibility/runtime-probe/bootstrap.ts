import {dlopen, FFIType, ptr} from 'bun:ffi';
import {h} from 'preact';
import render from 'preact-render-to-string';
import {createVerifiedBroker, verifyRetainedHeap} from './heap_probe';

console.error('[DEBUG-runtime] loader-start');
// Trusted phase: all module loading and application source reads precede install.
const native = dlopen('/probe/filter.so', {
  finish_fixture: {args:[FFIType.ptr,FFIType.u32],returns:FFIType.void},
  trace: {args: [FFIType.i32], returns: FFIType.void},
  event_audit_ack: {returns:FFIType.i32}, event_replace: {returns:FFIType.i32},
  event_inventory_count:{returns:FFIType.i32},
  event_inventory_fd:{args:[FFIType.i32],returns:FFIType.i32},
  event_inventory_kind:{args:[FFIType.i32],returns:FFIType.i32},
  event_prepare: {returns: FFIType.i32}, event_probe: {returns: FFIType.i32},
  event_errno: {returns: FFIType.i32}, event_negative: {args:[FFIType.i32],returns:FFIType.i32},
  architecture: {returns: FFIType.i32},
  prepare: {returns: FFIType.i32}, install: {returns: FFIType.i32},
  close_unrelated: {returns: FFIType.i32}, descriptors_closed: {returns: FFIType.i32},
  broker_exchange: {returns: FFIType.i32},
  check_thread: {returns: FFIType.i32},
  negative: {args: [FFIType.i32], returns: FFIType.i32},
}).symbols;
native.trace(0);
const nativeArchitecture = native.architecture();
const architecture = nativeArchitecture === 1 ? 'amd64' : nativeArchitecture === 2 ? 'arm64' : 'unknown';
const profile = JSON.parse(await Bun.file('/probe/profile.json').text());
if (profile.architecture !== architecture || !Array.isArray(profile.negative_controls) || profile.negative_controls.length !== 24) process.exit(16);
native.trace(1);
const negative_controls = profile.negative_controls;
const cgroups = {
  cpu: (await Bun.file('/sys/fs/cgroup/cpu.max').text()).trim(),
  memory: (await Bun.file('/sys/fs/cgroup/memory.max').text()).trim(),
  pids: (await Bun.file('/sys/fs/cgroup/pids.max').text()).trim(),
};
if (cgroups.cpu !== '100000 100000' || cgroups.memory !== '536870912' || cgroups.pids !== '64') process.exit(15);
native.trace(2);
const mode = process.argv[2] ?? 'healthy';
if (mode !== 'healthy' && mode !== 'busy' && mode !== 'event-replacement') process.exit(17);
const source = await Bun.file(mode === 'busy' ? '/probe/busy-application.js' : '/probe/application.js').text();
native.trace(3);
// Warm Preact/JSC. The fixture itself has not been evaluated or compiled.
native.trace(4);
if (render(h('p', null, 'trusted warmup')) !== '<p>trusted warmup</p>') process.exit(11);
native.trace(5);
native.trace(6);
if (native.prepare() !== 0) process.exit(12);
native.trace(7);
if (native.event_prepare() !== 0) process.exit(18);
native.trace(8);
if (native.close_unrelated() !== 0) process.exit(14);
native.trace(9);
if (mode === 'event-replacement') {
  const replacement = native.event_replace();
  console.error('[compat-event] replacement-fd=' + replacement);
  if (replacement <= 2) process.exit(20);
}
const descriptorsClosed = native.descriptors_closed() === 1;
native.trace(10);
const installed = native.install();
if (installed !== 0) process.exit(13);
native.trace(11);
const count = native.event_inventory_count();
if (count < 2 || count > 192) process.exit(21);
const kinds = ['eventfd','eventpoll','timerfd'];
const inventory = Array.from({length:count},(_,i)=>({fd:native.event_inventory_fd(i),kind:kinds[native.event_inventory_kind(i)-1]}));
console.log(JSON.stringify({kind:'startup-audit',inventory}));
if (native.event_audit_ack() !== 0) process.exit(22);
console.error('[compat-event] startup-approved');
const event_probe = native.event_probe();
console.error('[compat-event] result=' + event_probe + ' errno=' + native.event_errno());
if (event_probe !== 0) process.exit(17);
const event_negatives = Array.from({length:12},(_,i)=>native.event_negative(i));
if (event_negatives.some(result=>result !== -1)) process.exit(19);
const initialRuntimeGc = verifyRetainedHeap();
if (initialRuntimeGc.passed !== true) process.exit(23);
console.error('[compat-gc] retained-values-verified');
const verifiedBroker = createVerifiedBroker(native.broker_exchange, () => {
  console.error('[compat-gc] post-broker-retained-values-verified');
});
// Compilation and top-level fixture evaluation occur only after TSYNC success.
native.trace(12);
const application = new Function('h', 'render', 'negative', 'broker', 'trace', source);
native.trace(13);
native.trace(14);
const pending = application(h, render, native.negative, verifiedBroker.call, native.trace);
native.trace(15);
const result = await pending;
const runtime_gc = verifiedBroker.getEvidence();
if (runtime_gc === null || runtime_gc.passed !== true) process.exit(24);
native.trace(16);
native.trace(17);
const thread = native.check_thread();
native.trace(18);
native.trace(19);
const frame = new TextEncoder().encode(JSON.stringify({kind: 'runtime-evidence', architecture, negative_controls, cgroups, event_probe, event_negatives, install: installed, descriptors_closed: descriptorsClosed, ...result, runtime_gc_verified: runtime_gc.passed, runtime_gc, thread}) + '\n');
// This trusted strong root remains live while FFI holds only its raw pointer.
Object.defineProperty(globalThis,'__fleurCompatFixtureFrame',{value:frame,writable:false,configurable:false});
native.trace(20);
native.finish_fixture(ptr(frame),frame.byteLength);
