import {dlopen, FFIType} from 'bun:ffi';
import {h} from 'preact';
import render from 'preact-render-to-string';

// Trusted phase: all module loading and application source reads precede install.
const native = dlopen('/probe/filter.so', {
  prepare: {returns: FFIType.i32}, install: {returns: FFIType.i32},
  check_thread: {returns: FFIType.i32},
  negative: {args: [FFIType.i32], returns: FFIType.i32},
}).symbols;
const source = await Bun.file('/probe/application.js').text();
// Warm Preact/JSC. The fixture itself has not been evaluated or compiled.
if (render(h('p', null, 'trusted warmup')) !== '<p>trusted warmup</p>') process.exit(11);
if (native.prepare() !== 0) process.exit(12);
const installed = native.install();
if (installed !== 0) process.exit(13);
// Compilation and top-level fixture evaluation occur only after TSYNC success.
const application = new Function('h', 'render', 'negative', source);
const result = await application(h, render, native.negative);
console.log(JSON.stringify({install: installed, ...result, thread: native.check_thread()}));
process.exit(0);
