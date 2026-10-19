import {expect, test} from 'bun:test';
import {verifyRetainedHeap} from './heap_probe';

test('retained objects and typed arrays survive allocation pressure and forced collection', () => {
  expect(verifyRetainedHeap()).toEqual({
    passed: true,
    collections: 6,
    retained_objects: 128,
    retained_bytes: 16384,
    checksum: 8128,
  });
});
