import {expect, test} from 'bun:test';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVerifiedBroker, verifyRetainedHeap} from './heap_probe';

test('retained objects and typed arrays survive allocation pressure and forced collection', () => {
  expect(verifyRetainedHeap()).toEqual({
    passed: true,
    collections: 6,
    retained_objects: 128,
    retained_bytes: 16384,
    checksum: 8128,
  });
});

test('a registered broker reply verifies retained heap values before returning to the application', () => {
  const events: string[] = [];
  const broker = createVerifiedBroker(() => {
    events.push('registered-reply');
    return 0;
  }, evidence => {
    expect(evidence).toEqual({passed: true, collections: 6, retained_objects: 128,
      retained_bytes: 16384, checksum: 8128});
    events.push('heap-verified');
  });
  events.push(`application-result-${broker.call()}`);
  expect(events).toEqual(['registered-reply', 'heap-verified', 'application-result-0']);
});

test('a rejected broker exchange cannot produce a heap attestation', () => {
  const broker = createVerifiedBroker(() => -1, () => {
    throw new Error('rejected exchange claimed a heap attestation');
  });
  expect(broker.call()).toBe(-1);
});

test('post-broker verification uses the collector captured during trusted module loading', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Bun, 'gc');
  if (!descriptor) throw new Error('native collector unavailable');
  let mutableCalls = 0;
  let verified = false;
  try {
    Object.defineProperty(Bun, 'gc', {value: () => {
      mutableCalls++;
      throw new Error('mutable collector was used');
    }});
    const broker = createVerifiedBroker(() => 0, evidence => {
      expect(evidence.collections).toBe(6);
      expect(evidence.checksum).toBe(8128);
      verified = true;
    });
    expect(broker.call()).toBe(0);
    expect(verified).toBe(true);
    expect(mutableCalls).toBe(0);
  } finally {
    Object.defineProperty(Bun, 'gc', descriptor);
  }
});

test('trusted warmup cannot supply a broker that has not verified a reply with an attestation', () => {
  expect(verifyRetainedHeap().passed).toBe(true);
  const broker = createVerifiedBroker(() => 0, () => {});
  expect(broker.getEvidence()).toBeNull();
});

test('a later collection failure invalidates earlier post-broker evidence even when caught', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Bun, 'gc');
  if (!descriptor) throw new Error('native collector unavailable');
  const nativeCollector = Bun.gc.bind(Bun);
  const directory = mkdtempSync(join(tmpdir(), 'fleur-heap-fault-'));
  const modulePath = join(directory, 'heap_probe.ts');
  let collections = 0;
  try {
    // A fresh module exercises its trusted native-API capture boundary. Every
    // injected call still performs a real collection before the fault fires.
    copyFileSync(new URL('./heap_probe.ts', import.meta.url), modulePath);
    Object.defineProperty(Bun, 'gc', {value: (sync: boolean) => {
      const result = nativeCollector(sync);
      if (++collections === 7) throw new Error('injected collection failure');
      return result;
    }});
    const isolated = await import(modulePath) as typeof import('./heap_probe');
    Object.defineProperty(Bun, 'gc', descriptor);
    const broker = isolated.createVerifiedBroker(() => 0, () => {});
    expect(broker.call()).toBe(0);
    expect(broker.getEvidence()?.collections).toBe(6);
    expect(() => broker.call()).toThrow('injected collection failure');
    expect(broker.getEvidence()).toBeNull();
    expect(collections).toBe(7);
  } finally {
    Object.defineProperty(Bun, 'gc', descriptor);
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a rejected repeat clears a prior successful broker attestation', () => {
  let status = 0;
  const broker = createVerifiedBroker(() => status, () => {});
  expect(broker.call()).toBe(0);
  expect(broker.getEvidence()?.passed).toBe(true);
  status = -1;
  expect(broker.call()).toBe(-1);
  expect(broker.getEvidence()).toBeNull();
});


test('heap diagnostics delimit allocation and every synchronous collection with fixed bounded stages', () => {
  const stages: string[] = [];
  const proof = verifyRetainedHeap(stage => stages.push(stage));
  expect(proof.collections).toBe(6);
  expect(stages).toEqual([
    'entry', 'retained-allocated',
    'pressure-allocated-0', 'before-collection-0', 'after-collection-0', 'before-collection-1', 'after-collection-1',
    'pressure-allocated-1', 'before-collection-2', 'after-collection-2', 'before-collection-3', 'after-collection-3',
    'pressure-allocated-2', 'before-collection-4', 'after-collection-4', 'before-collection-5', 'after-collection-5',
    'complete',
  ]);
  expect(stages.join('\n').length).toBeLessThan(512);
});
