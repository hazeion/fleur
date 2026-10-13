// Inert source loaded by trusted bootstrap. Evaluation starts after TSYNC.
if (Bun.env.FLEUR_HOST_ONLY_CANARY !== undefined) throw new Error('host canary exclusion failed');
if (broker() !== 0) throw new Error('registered broker exchange failed');
// No runtime wait or timer: the application occupies its worker CPU until
// the trusted host terminates the owned container at the operation deadline.
let counter = 0;
let entered = false;
for (;;) {
  counter = (counter + 1) | 0;
  if (!entered) {entered = true; console.error('[compat-lifecycle] cpu-loop');}
}
