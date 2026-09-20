import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatYuan, parseYuan, splitByWeights, splitEvenly } from '../src/money.js';

test('split evenly with largest remainder: shares always sum to total', () => {
  for (const total of [1, 2, 3, 7, 10, 100, 3333, 10001]) {
    for (const n of [1, 2, 3, 6, 7]) {
      const parts = splitEvenly(total, n);
      assert.equal(parts.length, n);
      assert.equal(
        parts.reduce((a, b) => a + b, 0),
        total,
        `total ${total} / ${n} did not reconcile`,
      );
      const lo = Math.floor(total / n);
      for (const p of parts) assert.ok(p === lo || p === lo + 1);
    }
  }
});

test('rounding difference: 100.00 split across 3 groups (33.34 / 33.33 / 33.33)', () => {
  const parts = splitEvenly(10000, 3);
  assert.deepEqual(parts, [3334, 3333, 3333]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
});

test('proportional split by weights reconciles and is deterministic', () => {
  // 10.00 yuan shared 1:2:3 -> exact 166.67 / 333.33 / 500.00 cents
  const parts = splitByWeights(1000, [1, 2, 3]);
  assert.deepEqual(parts, [167, 333, 500]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
  // Deterministic across repeated calls (tie-break by index).
  assert.deepEqual(splitByWeights(1000, [1, 2, 3]), parts);
});

test('yuan parsing avoids float error', () => {
  assert.equal(parseYuan('33.33'), 3333);
  assert.equal(parseYuan('0.01'), 1);
  assert.equal(formatYuan(3333), '33.33');
  assert.equal(formatYuan(1), '0.01');
  assert.throws(() => parseYuan('1.234'));
});
