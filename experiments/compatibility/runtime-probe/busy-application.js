// Inert source loaded by trusted bootstrap. Evaluation starts after TSYNC.
if (broker() !== 0) throw new Error('registered broker exchange failed');
// No runtime wait or timer: the application occupies its worker CPU until
// the trusted host terminates the owned container at the operation deadline.
console.error('[compat-lifecycle] cpu-loop');
let counter = 0;
for (;;) counter = (counter + 1) | 0;
