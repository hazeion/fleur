// This file is read as inert bytes before installation. These top-level actions
// run only from new Function after the native TSYNC call returns exactly zero.
const main = Array.from({length: 24}, (_, i) => negative(i));
const broker_reply = broker() === 0 ? 'registered:Squat' : 'failed';
const html = render(h('p', null, 'restricted render'));
return Bun.file('/etc/passwd').text().then(
  () => ({main, html, broker_reply, application_open: false}),
  error => ({main, html, broker_reply, application_open: error.code === 'EPERM'}),
);
