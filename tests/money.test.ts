import { describe, it, expect } from 'vitest';
import {
  allocateByWeights,
  centsToYuan,
  formatCents,
  sumCents,
  yuanToCents,
} from '../src/domain/money.js';

describe('金额换算', () => {
  it('元转分不产生浮点误差', () => {
    expect(yuanToCents('0.1')).toBe(10);
    expect(yuanToCents('12.34')).toBe(1234);
    expect(yuanToCents(0.1 + 0.2)).toBe(30); // toFixed(2) 归一
    expect(() => yuanToCents('1.234')).toThrow();
  });

  it('分转元与格式化', () => {
    expect(centsToYuan(1234)).toBe(12.34);
    expect(formatCents(-5)).toBe('-0.05');
  });
});

describe('最大余数法分摊（舍入差异）', () => {
  it('100 元按三等分：33.33 / 33.33 / 33.34，合计精确等于 100.00', () => {
    const parts = allocateByWeights(10000, [1, 1, 1]);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(sumCents(parts)).toBe(10000);
  });

  it('10 元按 1:1:1：3.34 / 3.33 / 3.33', () => {
    const parts = allocateByWeights(1000, [1, 1, 1]);
    expect(parts).toEqual([334, 333, 333]);
    expect(sumCents(parts)).toBe(1000);
  });

  it('按权重 1:2:3 拆分 100.01 元，总额守恒且最大份额误差不超过 1 分', () => {
    const total = 10001;
    const weights = [1, 2, 3];
    const parts = allocateByWeights(total, weights);
    expect(sumCents(parts)).toBe(total);
    const exact = weights.map((w) => (total * w) / 6);
    parts.forEach((p, i) => {
      expect(Math.abs(p - exact[i])).toBeLessThanOrEqual(1);
    });
  });

  it('权重非法时抛错', () => {
    expect(() => allocateByWeights(100, [0, 0])).toThrow();
    expect(() => allocateByWeights(100, [1, -1])).toThrow();
  });
});
