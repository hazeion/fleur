// This file is read as inert bytes before installation. These top-level actions
// run only from new Function after the native TSYNC call returns exactly zero.
const main = Array.from({length: 10}, (_, i) => negative(i));
const html = render(h('p', null, 'restricted render'));
return Bun.file('/etc/passwd').text().then(
  () => ({main, html, application_open: false}),
  error => ({main, html, application_open: error.code === 'EPERM'}),
);
