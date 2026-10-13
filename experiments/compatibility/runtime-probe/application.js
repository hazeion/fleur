// This file is read as inert bytes before installation. These top-level actions
// run only from new Function after the native TSYNC call returns exactly zero.
trace(27);
const host_canary_absent = Bun.env.FLEUR_HOST_ONLY_CANARY === undefined;
const main = Array.from({length: 24}, (_, i) => negative(i));
trace(28);
const broker_reply = broker() === 0 ? 'registered:Squat' : 'failed';
trace(29);
const html = render(h('p', null, 'restricted render'));
trace(30);
trace(31);
const deniedFile = Bun.file('/etc/passwd').text();
trace(32);
return deniedFile.then(
  () => {trace(34); return {main, html, broker_reply, host_canary_absent, application_open: false};},
  error => {trace(33); return {main, html, broker_reply, host_canary_absent, application_open: error.code === 'EPERM'};},
);
