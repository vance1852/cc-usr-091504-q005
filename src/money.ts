/**
 * Money handling. Every amount inside the system is an integer number of
 * cents (分) — no floats ever touch an accounting value.
 *
 * Split invoices use the largest-remainder (Hamilton) method so that the
 * allocations always sum back to the voucher total exactly.
 */

export function assertCents(value: number, field = 'amount_cents'): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer (cents), got ${value}`);
  }
  return value;
}

/** Split `total` cents into `n` equal shares with no lost cent. */
export function splitEvenly(total: number, n: number): number[] {
  return splitByWeights(total, Array.from({ length: n }, () => 1));
}

/**
 * Split `total` across parts proportional to `weights` using the
 * largest-remainder method. Ties are broken by part index so the result is
 * deterministic.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  assertCents(total, 'total');
  if (weights.length === 0) throw new RangeError('weights must not be empty');
  const weightSum = weights.reduce((a, b) => {
    if (!Number.isFinite(b) || b < 0) throw new RangeError('invalid weight');
    return a + b;
  }, 0);
  if (weightSum <= 0) throw new RangeError('weights must sum to a positive number');

  const exact = weights.map((w) => (total * w) / weightSum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  // Distribute the leftover cents to the parts with the largest fractional part.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder === 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

/** Parse a yuan string like "33.33" into cents without float rounding. */
export function parseYuan(input: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(input)) {
    throw new TypeError(`invalid yuan amount: ${input}`);
  }
  const [whole, frac = ''] = input.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Format cents back into a yuan string, e.g. 3333 -> "33.33". */
export function formatYuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
