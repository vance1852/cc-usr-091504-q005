/**
 * 金额工具：内部一律使用「分」的整数表示，避免浮点舍入误差。
 * 输入金额使用字符串或数字（元，最多两位小数）。
 */

export type Cents = number;

/** 元 -> 分，仅接受最多两位小数，禁止 0.1+0.2 这类浮点输入直接参与计算 */
export function yuanToCents(yuan: number | string): Cents {
  const s = typeof yuan === 'number' ? yuan.toFixed(2) : yuan.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`非法金额: ${yuan}`);
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ''] = body.split('.');
  const cents =
    Number(intPart) * 100 + Number((fracPart + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/** 分 -> 元（数字，两位小数） */
export function centsToYuan(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** 分 -> 元字符串，如 1234 -> "12.34" */
export function formatCents(cents: Cents): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/**
 * 按权重把 totalCents 拆成 n 份，保证各份之和恰好等于总额，
 * 余数（每份不足 1 分的部分）按最大余数法依次分给前若干份。
 * weights 为正整数或正实数权重。
 */
export function allocateByWeights(
  totalCents: Cents,
  weights: number[],
): Cents[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new Error('权重不能为负');
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) throw new Error('权重之和必须为正');

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const floored = exact.map((x) => Math.floor(x));
  let remainder = totalCents - floored.reduce((a, b) => a + b, 0);
  // 按小数部分从大到小分配余差（平局时保持原顺序，保证确定性）
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i] += 1;
    remainder -= 1;
  }
  return floored;
}

/** 多个分摊行金额之和（分） */
export function sumCents(xs: Cents[]): Cents {
  return xs.reduce((a, b) => a + b, 0);
}
