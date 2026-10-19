// Capture the native collector during trusted module loading. Application
// evaluation cannot substitute a later Bun.gc property value for this proof.
const collectGarbage = Bun.gc.bind(Bun);

/** Trusted compatibility evidence, executed after the worker restriction audit. */
export function verifyRetainedHeap() {
  const retained = Array.from({length: 128}, (_, index) => ({
    index,
    label: `retained-${index}`,
    bytes: new Uint8Array(128).fill(index + 17),
  }));
  let collections = 0;
  function inspectRetained() {
    let checksum = 0;
    for (let index = 0; index < retained.length; index++) {
      const row = retained[index];
      if (row.index !== index || row.label !== `retained-${index}` || row.bytes.byteLength !== 128) {
        throw new Error('runtime heap retention failed');
      }
      for (const byte of row.bytes) {
        if (byte !== index + 17) throw new Error('runtime typed-array retention failed');
      }
      checksum += row.index;
    }
    if (checksum !== 8128) throw new Error('runtime heap checksum failed');
    return checksum;
  }
  for (let round = 0; round < 3; round++) {
    // Keep the pressure live through one collection, then release it before
    // another. This verifies both allocation and retained references; merely
    // collecting an otherwise empty heap would not exercise this contract.
    let pressure: {index: number; bytes: Uint8Array}[] | null = Array.from({length: 16384}, (_, index) => ({
      index,
      bytes: new Uint8Array(64).fill(index & 255),
    }));
    collectGarbage(true);
    collections++;
    if (pressure.length !== 16384 || pressure[0].index !== 0 || pressure[0].bytes[0] !== 0
        || pressure[16383].index !== 16383 || pressure[16383].bytes[63] !== 255) {
      throw new Error('runtime allocation retention failed');
    }
    inspectRetained();
    pressure = null;
    collectGarbage(true);
    collections++;
    inspectRetained();
  }
  return {passed: true, collections, retained_objects: retained.length,
    retained_bytes: retained.reduce((total, row) => total + row.bytes.byteLength, 0),
    checksum: inspectRetained()};
}

/** Recheck the heap after the admitted host exchange, before application resumes. */
export function createVerifiedBroker(exchange: () => number,
  onVerified: (evidence: ReturnType<typeof verifyRetainedHeap>) => void) {
  let evidence: ReturnType<typeof verifyRetainedHeap> | null = null;
  return {
    call: () => {
      evidence = null;
      const status = exchange();
      if (status === 0) {
        const verified = verifyRetainedHeap();
        onVerified(verified);
        evidence = verified;
      }
      return status;
    },
    getEvidence: () => evidence,
  };
}
