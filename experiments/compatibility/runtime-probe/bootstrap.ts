import {dlopen, FFIType} from 'bun:ffi';
import {h} from 'preact';
import render from 'preact-render-to-string';

// Trusted phase: all module loading and application source reads precede install.
const native = dlopen('/probe/filter.so', {
  prepare: {returns: FFIType.i32}, install: {returns: FFIType.i32},
  close_unrelated: {returns: FFIType.i32}, descriptors_closed: {returns: FFIType.i32},
  broker_exchange: {returns: FFIType.i32},
  check_thread: {returns: FFIType.i32},
  negative: {args: [FFIType.i32], returns: FFIType.i32},
}).symbols;
const cgroups = {
  cpu: (await Bun.file('/sys/fs/cgroup/cpu.max').text()).trim(),
  memory: (await Bun.file('/sys/fs/cgroup/memory.max').text()).trim(),
  pids: (await Bun.file('/sys/fs/cgroup/pids.max').text()).trim(),
};
if (cgroups.cpu !== '100000 100000' || cgroups.memory !== '536870912' || cgroups.pids !== '64') process.exit(15);
const source = await Bun.file('/probe/application.js').text();
// Warm Preact/JSC. The fixture itself has not been evaluated or compiled.
if (render(h('p', null, 'trusted warmup')) !== '<p>trusted warmup</p>') process.exit(11);
if (native.prepare() !== 0) process.exit(12);
if (native.close_unrelated() !== 0) process.exit(14);
const descriptorsClosed = native.descriptors_closed() === 1;
const installed = native.install();
if (installed !== 0) process.exit(13);
// Compilation and top-level fixture evaluation occur only after TSYNC success.
const application = new Function('h', 'render', 'negative', 'broker', source);
const result = await application(h, render, native.negative, native.broker_exchange);
console.log(JSON.stringify({kind: 'runtime-evidence', cgroups, install: installed, descriptors_closed: descriptorsClosed, ...result, thread: native.check_thread()}));
process.exit(0);
